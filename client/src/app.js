import { LitElement, html } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import './style.css';

const letters = ['A', 'B', 'C', 'D'];
const optionKeys = { A: 'option_a', B: 'option_b', C: 'option_c', D: 'option_d' };

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(data?.error || `Request failed (${response.status}).`);
    error.details = data?.details || [];
    error.status = response.status;
    throw error;
  }
  return data;
}

function htmlTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = value % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${minutes}:${String(rest).padStart(2, '0')}`;
}

class McqApp extends LitElement {
  createRenderRoot() { return this; }

  constructor() {
    super();
    this.page = 'home';
    this.directExamId = location.pathname.match(/^\/exam\/(\d+)\/?$/)?.[1] || '';
    this.directExam = null;
    this.adminLoggedIn = false;
    this.adminTab = 'questions';
    this.exams = [];
    this.questions = [];
    this.publicExams = [];
    this.selectedExam = null;
    this.attempt = null;
    this.answers = {};
    this.currentQuestion = 0;
    this.remainingSeconds = 0;
    this.timer = null;
    this.searchText = '';
    this.categoryFilter = '';
    this.difficultyFilter = '';
    this.questionPage = 0;
    this.pageSize = 14;
    this.questionFormOpen = false;
    this.bulkImportOpen = false;
    this.editingQuestion = null;
    this.selectionMode = 'manual';
    this.selectionIds = [];
    this.examSubject = '';
    this.randomCount = 10;
    this.selectionSearch = '';
    this.resultExam = null;
    this.attempts = [];
    this.answerSheet = null;
    this.startingExam = null;
    this.toast = null;
    this.busy = false;
    this.answerSaveQueue = Promise.resolve();
    this.pendingAnswerSaves = 0;
    this.answerSaveError = false;
    this.error = '';
    this.adminLoginError = '';
    this.passwordError = '';
    this.passwordBusy = false;
    this.resumeToken = sessionStorage.getItem('mcq-attempt-token') || '';
  }

  connectedCallback() {
    super.connectedCallback();
    this.initialize();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this.timer);
  }

  async initialize() {
    const [exams, session] = await Promise.allSettled([
      api('/api/exams'),
      api('/api/admin/session'),
    ]);
    this.publicExams = exams.status === 'fulfilled' ? exams.value : [];
    this.adminLoggedIn = session.status === 'fulfilled' && session.value.authenticated;
    if (this.directExamId) {
      try {
        this.directExam = await api(`/api/exams/${encodeURIComponent(this.directExamId)}`);
        this.page = 'direct';
      } catch {
        this.directExam = null;
        this.page = 'unavailable';
      }
    }
    this.requestUpdate();
    if (this.resumeToken) {
      try { await this.loadAttempt(this.resumeToken, this.directExamId); } catch { sessionStorage.removeItem('mcq-attempt-token'); this.resumeToken = ''; }
    }
  }

  notify(message, kind = 'success', details = []) {
    this.toast = { message, kind, details };
    this.requestUpdate();
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.toast = null; this.requestUpdate(); }, 3600);
  }

  async enterAdmin() {
    if (!this.adminLoggedIn) {
      this.page = 'login';
      this.adminLoginError = '';
      this.requestUpdate();
      return;
    }
    this.page = 'admin';
    this.adminTab = 'questions';
    await this.loadAdminData();
  }

  async loadAdminData() {
    try {
      const [questions, exams] = await Promise.all([
        api('/api/admin/questions'), api('/api/admin/exams'),
      ]);
      this.questions = questions;
      this.exams = exams;
      this.requestUpdate();
    } catch (error) { this.notify(error.message, 'error'); }
  }

  async login(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    this.busy = true;
    this.adminLoginError = '';
    try {
      await api('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: data.get('username'), password: data.get('password') }) });
      this.adminLoggedIn = true;
      this.page = 'admin';
      this.adminTab = 'questions';
      await this.loadAdminData();
    } catch (error) { this.adminLoginError = error.message; }
    finally { this.busy = false; this.requestUpdate(); }
  }

  async logout() {
    try { await api('/api/admin/logout', { method: 'POST' }); } catch { /* expired session */ }
    this.adminLoggedIn = false;
    this.clearAdminSession();
    this.page = 'home';
    this.notify('You are signed out.');
  }

  clearAdminSession() {
    this.adminLoggedIn = false;
    this.questions = [];
    this.exams = [];
    this.answerSheet = null;
    this.attempts = [];
    this.resultExam = null;
  }

  get filteredQuestions() {
    const query = this.searchText.trim().toLowerCase();
    return this.questions.filter((question) => {
      const matchesText = !query || `${question.question_text} ${question.category}`.toLowerCase().includes(query);
      return matchesText && (!this.categoryFilter || question.category === this.categoryFilter)
        && (!this.difficultyFilter || question.difficulty === this.difficultyFilter);
    });
  }

  get selectionQuestions() {
    const query = this.selectionSearch.trim().toLowerCase();
    return this.questions.filter((question) => question.category === this.examSubject
      && (!query || `${question.question_text} ${question.category}`.toLowerCase().includes(query)));
  }

  get questionCategories() { return [...new Set(this.questions.map((q) => q.category).filter(Boolean))].sort(); }
  get questionDifficulties() { return [...new Set(this.questions.map((q) => q.difficulty).filter(Boolean))].sort(); }

  openQuestionForm(question = null) {
    this.editingQuestion = question;
    this.questionFormOpen = true;
    this.error = '';
    this.requestUpdate();
  }

  async saveQuestion(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const payload = {
      question_text: values.question_text, option_a: values.option_a, option_b: values.option_b,
      option_c: values.option_c, option_d: values.option_d, correct_option: values.correct_option,
      category: values.category, difficulty: values.difficulty, explanation: values.explanation,
    };
    this.busy = true;
    try {
      await api(this.editingQuestion ? `/api/admin/questions/${this.editingQuestion.id}` : '/api/admin/questions', {
        method: this.editingQuestion ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      this.questionFormOpen = false;
      await this.loadAdminData();
      this.notify(this.editingQuestion ? 'Question updated.' : 'Question added to the bank.');
    } catch (error) { this.notify([error.message, ...(error.details || [])].join(' '), 'error'); }
    finally { this.busy = false; this.requestUpdate(); }
  }

  async deleteQuestion(question) {
    if (!window.confirm('Delete this question from the bank?')) return;
    try {
      await api(`/api/admin/questions/${question.id}`, { method: 'DELETE' });
      await this.loadAdminData();
      this.notify('Question deleted.');
    } catch (error) { this.notify(error.message, 'error'); }
  }

  async importWorkbook(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    const subject = this.querySelector('[name="excel_subject"]')?.value.trim();
    if (subject) form.append('subject', subject);
    this.busy = true;
    try {
      const result = await api('/api/admin/questions/import', { method: 'POST', body: form });
      await this.loadAdminData();
      this.notify(`${result.imported} questions imported successfully.`);
    } catch (error) {
      this.notify(error.message, 'error', error.details || []);
    } finally { event.target.value = ''; this.busy = false; this.requestUpdate(); }
  }

  async importPastedQuestions(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const text = String(values.text || '').trim();
    const questionCount = (text.match(/^\s*\d+\.\s+.+$/gm) || []).length;
    if (!values.subject?.trim()) { this.notify('Enter a subject for these questions.', 'error'); return; }
    if (!questionCount) { this.notify('Add at least one numbered question using the sample format.', 'error'); return; }
    if (questionCount > 300) { this.notify('A single paste can contain up to 300 questions.', 'error'); return; }
    this.busy = true;
    try {
      const result = await api('/api/admin/questions/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: values.subject.trim(), text }),
      });
      this.bulkImportOpen = false;
      form.reset();
      await this.loadAdminData();
      this.notify(`${result.imported} questions uploaded successfully.`);
    } catch (error) { this.notify(error.message, 'error', error.details || []); }
    finally { this.busy = false; this.requestUpdate(); }
  }

  toggleSelectedQuestion(id, checked) {
    this.selectionIds = checked ? [...this.selectionIds, id] : this.selectionIds.filter((value) => value !== id);
    this.requestUpdate();
  }

  regenerateRandom() {
    const available = this.questions.filter((q) => q.category === this.examSubject).map((q) => q.id);
    if (!available.length) {
      this.selectionIds = [];
      this.requestUpdate();
      return;
    }
    const amount = Math.max(1, Math.min(available.length, Number(this.randomCount) || 1));
    for (let index = available.length - 1; index > 0; index -= 1) {
      const other = Math.floor(Math.random() * (index + 1));
      [available[index], available[other]] = [available[other], available[index]];
    }
    this.selectionIds = available.slice(0, amount);
    this.randomCount = amount;
    this.requestUpdate();
  }

  async createExam(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (!this.examSubject) { this.notify('Choose a subject before selecting exam questions.', 'error'); return; }
    if (this.selectionMode === 'random' && !this.selectionIds.length) this.regenerateRandom();
    const selected = this.selectionIds;
    if (!selected.length) { this.notify('Select at least one available question.', 'error'); return; }
    const payload = {
      title: values.title, description: values.description, duration_minutes: Number(values.duration_minutes),
      subject: this.examSubject, negative_mark: Number(values.negative_mark),
      status: values.status, show_score: event.currentTarget.elements.show_score.checked,
      show_answers: event.currentTarget.elements.show_answers.checked, question_ids: selected,
    };
    this.busy = true;
    try {
      const created = await api('/api/admin/exams', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      this.selectionIds = [];
      this.selectionSearch = '';
      await this.loadAdminData();
      if (created.status === 'published') this.notify(`Examination created. Share ${this.examUrl(created)} with students.`);
      else this.notify('Examination created as a draft. Publish it to enable its public link.');
    } catch (error) { this.notify([error.message, ...(error.details || [])].join(' '), 'error'); }
    finally { this.busy = false; this.requestUpdate(); }
  }

  examUrl(exam) { return new URL(`/exam/${exam.id}`, location.origin).href; }

  async copyExamLink(exam) {
    if (exam.status !== 'published') return;
    const url = this.examUrl(exam);
    try {
      await navigator.clipboard.writeText(url);
      this.notify('Public exam link copied.');
    } catch {
      window.prompt('Copy this public exam link:', url);
    }
  }

  async changePassword(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    this.passwordError = '';
    if (values.new_password !== values.confirm_password) {
      this.passwordError = 'The new passwords do not match.';
      this.requestUpdate();
      return;
    }
    this.passwordBusy = true;
    try {
      await api('/api/admin/password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: values.current_password, new_password: values.new_password }),
      });
      form.reset();
      this.clearAdminSession();
      this.page = 'home';
      this.adminTab = 'questions';
      this.notify('Password changed. Sign in again with your new password.');
    } catch (error) { this.passwordError = error.message; }
    finally { this.passwordBusy = false; this.requestUpdate(); }
  }

  async changeExamStatus(exam, status) {
    try {
      await api(`/api/admin/exams/${exam.id}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
      await this.loadAdminData();
      this.notify(`Exam marked ${status}.`);
      await this.loadPublicExams();
    } catch (error) { this.notify(error.message, 'error'); }
  }

  async changeExamVisibility(exam, field, checked) {
    const showScore = field === 'score' ? checked : Boolean(exam.show_score);
    const showAnswers = field === 'answers' ? checked : Boolean(exam.show_answers);
    const nextShowAnswers = showScore ? showAnswers : false;
    try {
      await api(`/api/admin/exams/${exam.id}/settings`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ show_score: showScore, show_answers: nextShowAnswers }),
      });
      await this.loadAdminData();
      this.notify('Student result visibility updated.');
    } catch (error) { this.notify(error.message, 'error'); }
  }

  async deleteExam(exam) {
    if (!confirm(`Delete "${exam.title}" and all its answer sheets? This cannot be undone.`)) return;
    try {
      await api(`/api/admin/exams/${exam.id}`, { method: 'DELETE' });
      if (this.resultExam?.id === exam.id) { this.resultExam = null; this.answerSheet = null; this.attempts = []; }
      await this.loadAdminData();
      await this.loadPublicExams();
      this.notify('Exam and answer sheets deleted.');
    } catch (error) { this.notify(error.message, 'error'); }
  }

  async deleteAttempt(attempt) {
    if (!confirm(`Delete the answer sheet for ${attempt.student_name}? This cannot be undone.`)) return;
    try {
      await api(`/api/admin/attempts/${attempt.id}`, { method: 'DELETE' });
      await this.loadAttempts(this.resultExam);
      await this.loadAdminData();
      this.notify('Answer sheet deleted.');
    } catch (error) { this.notify(error.message, 'error'); }
  }

  async loadAttempts(exam) {
    this.resultExam = exam;
    this.answerSheet = null;
    try { this.attempts = await api(`/api/admin/exams/${exam.id}/attempts`); }
    catch (error) { this.notify(error.message, 'error'); }
    this.requestUpdate();
  }

  async openAnswerSheet(attempt) {
    try { this.answerSheet = await api(`/api/admin/attempts/${attempt.id}`); }
    catch (error) { this.notify(error.message, 'error'); }
    this.requestUpdate();
  }

  async loadPublicExams() {
    try { this.publicExams = await api('/api/exams'); }
    catch { this.publicExams = []; }
    this.requestUpdate();
  }

  async openStart(exam) {
    this.startingExam = { ...exam, loadingDetails: true };
    this.requestUpdate();
    try {
      const details = await api(`/api/exams/${encodeURIComponent(exam.id)}`);
      if (this.startingExam?.id === exam.id) this.startingExam = details;
    } catch {
      if (this.startingExam?.id === exam.id) this.startingExam = exam;
    }
    this.requestUpdate();
  }

  async startExam(event) {
    event.preventDefault();
    const exam = this.startingExam || (this.page === 'direct' ? this.directExam : null);
    if (!exam) return;
    const values = Object.fromEntries(new FormData(event.currentTarget));
    this.busy = true;
    try {
      const result = await api(`/api/exams/${exam.id}/attempts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values),
      });
      this.resumeToken = result.token;
      sessionStorage.setItem('mcq-attempt-token', result.token);
      this.startingExam = null;
      await this.loadAttempt(result.token);
    } catch (error) { this.notify(error.message, 'error'); }
    finally { this.busy = false; this.requestUpdate(); }
  }

  async loadAttempt(token, expectedExamId = '') {
    const result = await api(`/api/attempts/${encodeURIComponent(token)}`);
    if (expectedExamId && String(result.exam_id) !== String(expectedExamId)) {
      sessionStorage.removeItem('mcq-attempt-token');
      this.resumeToken = '';
      return false;
    }
    this.attempt = result;
    this.answers = Object.fromEntries(result.answers.map((answer) => [answer.question_id, answer.selected_option]));
    this.currentQuestion = Math.min(this.currentQuestion, Math.max(0, result.questions.length - 1));
    if (result.status === 'in_progress') {
      this.page = 'exam';
      this.remainingSeconds = result.remaining_seconds;
      this.startTimer();
    } else {
      this.page = 'result';
      clearInterval(this.timer);
    }
    this.requestUpdate();
    return true;
  }

  startTimer() {
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.remainingSeconds = Math.max(0, this.remainingSeconds - 1);
      this.requestUpdate();
      if (this.remainingSeconds <= 0) this.submitAttempt(true);
    }, 1000);
  }

  async selectAnswer(question, selectedOption) {
    if (this.busy || this.attempt?.status !== 'in_progress') return;
    this.answers = { ...this.answers, [question.id]: selectedOption };
    this.pendingAnswerSaves += 1;
    this.requestUpdate();
    const token = this.resumeToken;
    const save = this.answerSaveQueue.catch(() => {}).then(() => api(`/api/attempts/${encodeURIComponent(token)}/answers`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question_id: question.id, selected_option: selectedOption }),
    }));
    this.answerSaveQueue = save;
    try {
      await save;
    } catch (error) {
      this.answerSaveError = true;
      this.notify(error.message, 'error');
      if (error.status === 409) await this.loadAttempt(this.resumeToken);
    } finally {
      this.pendingAnswerSaves -= 1;
      this.requestUpdate();
    }
  }

  async submitAttempt(auto = false) {
    if (!this.attempt || this.attempt.status !== 'in_progress' || this.busy) return;
    if (!auto) {
      const unanswered = this.attempt.questions.length - Object.values(this.answers).filter(Boolean).length;
      if (unanswered && !window.confirm(`You have ${unanswered} unanswered ${unanswered === 1 ? 'question' : 'questions'}. Submit anyway?`)) return;
    }
    this.busy = true;
    try {
      await this.answerSaveQueue.catch(() => {});
      if (this.answerSaveError) {
        this.answerSaveError = false;
        await this.loadAttempt(this.resumeToken);
        this.notify('An answer could not be saved. Check your selections and submit again.', 'error');
        return;
      }
      const result = await api(`/api/attempts/${encodeURIComponent(this.resumeToken)}/submit`, { method: 'POST' });
      clearInterval(this.timer);
      this.attempt = { ...this.attempt, status: result.result?.status || 'submitted', result: result.result };
      this.page = 'result';
      this.notify(auto ? 'Time is up. Your answers have been submitted.' : 'Your exam has been submitted.');
    } catch (error) { this.notify(error.message, 'error'); await this.loadAttempt(this.resumeToken); }
    finally { this.busy = false; this.requestUpdate(); }
  }

  newAttempt() {
    clearInterval(this.timer);
    sessionStorage.removeItem('mcq-attempt-token');
    this.resumeToken = '';
    this.attempt = null;
    this.answers = {};
    this.page = 'home';
    this.directExam = null;
    this.directExamId = '';
    if (location.pathname !== '/') history.replaceState({}, '', '/');
    this.loadPublicExams();
  }

  dismissStart() { this.startingExam = null; this.requestUpdate(); }

  render() {
    return html`
      <div class="app-shell">
        ${this.page !== 'exam' ? this.renderHeader() : ''}
        ${this.page === 'home' ? this.renderHome() : ''}
        ${this.page === 'direct' ? this.renderDirectExam() : ''}
        ${this.page === 'unavailable' ? this.renderUnavailableExam() : ''}
        ${this.page === 'login' ? this.renderLogin() : ''}
        ${this.page === 'admin' ? this.renderAdmin() : ''}
        ${this.page === 'exam' ? this.renderExam() : ''}
        ${this.page === 'result' ? this.renderStudentResult() : ''}
        ${this.startingExam ? this.renderStartDialog() : ''}
        ${this.toast ? html`<div class="toast ${this.toast.kind}" role="status"><b>${this.toast.message}</b>${this.toast.details?.length ? html`<ul>${this.toast.details.map((detail) => html`<li>${detail}</li>`)}</ul>` : ''}</div>` : ''}
      </div>
    `;
  }

  renderHeader() {
    return html`<header class="site-header">
      <button class="brand" @click=${this.newAttempt} aria-label="Northstar home"><span class="brand-mark">N</span><span>northstar<span class="brand-dot">.</span><small>EXAMINATION PORTAL</small></span></button>
      <div class="header-actions">
        ${this.page === 'admin' ? html`<span class="admin-pill"><span class="status-dot"></span> Admin workspace</span>` : html`<span class="secure-label"><span class="shield">◆</span> Secure examination portal</span>`}
        ${this.page === 'admin' ? html`<button class="button button-quiet button-small" @click=${this.logout}>Sign out</button>` : html`<button class="button button-outline button-small" @click=${this.enterAdmin}>${this.adminLoggedIn ? 'Admin dashboard' : 'Admin sign in'} <span aria-hidden="true">↗</span></button>`}
      </div>
    </header>`;
  }

  renderHome() {
    return html`<main class="home-main">
      <section class="welcome-panel">
        <div class="welcome-copy">
          <span class="eyebrow"><span class="eyebrow-line"></span> LEARN · PREPARE · ACHIEVE</span>
          <h1>Your next step<br /><em>starts here.</em></h1>
          <p>Focused assessments, a clear path forward. Choose an examination below when you’re ready.</p>
          <div class="welcome-foot"><span class="soft-icon">✦</span> A calm space to do your best work</div>
        </div>
        <div class="welcome-art" aria-hidden="true">
          <div class="art-orbit orbit-one"></div><div class="art-orbit orbit-two"></div>
          <div class="art-sun"></div><div class="art-paper"><div class="paper-top"><span></span><span></span><span></span></div><div class="paper-check">✓</div><div class="paper-line wide"></div><div class="paper-line"></div><div class="paper-line short"></div><div class="paper-score">Ready<span>set, focus</span></div></div>
          <div class="art-star star-one">✦</div><div class="art-star star-two">✧</div>
        </div>
        <div class="welcome-index">01 <span>—</span> 03</div>
      </section>

      <section class="exams-section">
        <div class="section-heading"><div><span class="eyebrow muted">YOUR OPPORTUNITY</span><h2>Available examinations</h2></div><span class="exam-count">${this.publicExams.length} ${this.publicExams.length === 1 ? 'examination' : 'examinations'}</span></div>
        ${this.publicExams.length ? html`<div class="exam-grid">${this.publicExams.map((exam, index) => html`
          <article class="exam-card">
            <div class="exam-card-top"><span class="exam-number">${String(index + 1).padStart(2, '0')}</span><span class="live-label"><span></span> OPEN</span></div>
            <h3>${exam.title}</h3><p class="exam-description">${exam.description || 'A focused assessment to show what you know.'}</p>
            <div class="exam-meta"><span><b>${exam.question_count}</b> questions</span><span class="meta-separator"></span><span><b>${exam.duration_minutes}</b> min</span></div>
            <button class="button button-primary button-full" @click=${() => this.openStart(exam)}>Start examination <span aria-hidden="true">→</span></button>
          </article>`)}
        </div>` : html`<div class="empty-state exam-empty"><div class="empty-illustration">⌁</div><h3>Nothing scheduled just yet</h3><p>Published examinations will appear here when they’re ready.</p></div>`}
      </section>
      <footer class="page-footer"><span>© ${new Date().getFullYear()} Northstar Examination Portal</span><span>Thoughtful assessment, made simple <b>✦</b></span></footer>
    </main>`;
  }

  renderDirectExam() {
    const exam = this.directExam;
    if (!exam) return this.renderUnavailableExam();
    const penalty = Number(exam.negative_mark || 0);
    return html`<main class="direct-exam-page"><section class="direct-exam-card"><span class="eyebrow muted">PUBLIC EXAMINATION LINK</span><div class="direct-exam-heading"><div><h1>${exam.title}</h1><p>${exam.subject || 'Examination'} · ${exam.question_count} questions · ${exam.duration_minutes} minutes</p></div><span class="status-tag published">OPEN</span></div>
      ${exam.description ? html`<p class="direct-exam-description">${exam.description}</p>` : ''}
      <div class="direct-exam-rule"><span>✦</span><span><b>Scoring rule</b><small>Each correct answer earns 1 mark. A wrong answer loses ${penalty} mark${penalty === 1 ? '' : 's'}; unanswered questions receive no penalty.</small></span></div>
      <div class="direct-entry-heading"><h2>Enter your details to begin</h2><p>Your timer starts when you begin. Answers save automatically.</p></div>
      <form class="stack-form direct-entry-form" @submit=${this.startExam}>
        <label>Full name<input name="student_name" required maxlength="120" autocomplete="name" placeholder="Your name" /></label>
        <label>Email<input name="email" type="email" required maxlength="254" autocomplete="email" placeholder="you@example.com" /></label>
        <label>Address<input name="address" required maxlength="500" autocomplete="street-address" placeholder="Your address" /></label>
        <label>Roll number<input name="roll_number" required maxlength="60" placeholder="Your roll number" /></label>
        <button class="button button-primary button-full" ?disabled=${this.busy}>${this.busy ? 'Preparing your exam…' : 'Begin examination'} <span>→</span></button>
      </form>
    </section><footer class="login-footer">NORTHSTAR · EXAMINATION PORTAL</footer></main>`;
  }

  renderUnavailableExam() {
    return html`<main class="unavailable-page"><section class="unavailable-card"><div class="empty-illustration">⌁</div><span class="eyebrow muted">EXAMINATION UNAVAILABLE</span><h1>This exam is not available</h1><p>The link may be incorrect, the exam may still be a draft, or it may have closed.</p><button class="button button-primary" @click=${this.newAttempt}>View available examinations <span>→</span></button></section></main>`;
  }

  renderLogin() {
    return html`<main class="login-page"><button class="back-link" @click=${() => { this.page = 'home'; this.requestUpdate(); }}>← <span>Back to examinations</span></button>
      <div class="login-card"><div class="login-icon">⌘</div><span class="eyebrow muted">ADMINISTRATOR ACCESS</span><h1>Welcome back</h1><p>Sign in to manage your question bank and examinations.</p>
        <form class="stack-form" @submit=${this.login}>
          <label>Username<input name="username" autocomplete="username" required placeholder="Enter your username" /></label>
          <label>Password<input name="password" type="password" autocomplete="current-password" required placeholder="Enter your password" /></label>
          ${this.adminLoginError ? html`<div class="inline-error">${this.adminLoginError}</div>` : ''}
          <button class="button button-primary button-full" ?disabled=${this.busy}>${this.busy ? 'Signing in…' : 'Sign in securely'} <span aria-hidden="true">→</span></button>
        </form><div class="login-foot"><span>▣</span> Your session is protected and private</div>
      </div><footer class="login-footer">NORTHSTAR · EXAMINATION PORTAL</footer>
    </main>`;
  }

  renderAdmin() {
    const pageQuestions = this.filteredQuestions.slice(this.questionPage * this.pageSize, (this.questionPage + 1) * this.pageSize);
    const pageCount = Math.max(1, Math.ceil(this.filteredQuestions.length / this.pageSize));
    return html`<main class="admin-main">
      <div class="admin-welcome"><div><span class="eyebrow muted">OVERVIEW</span><h1>Good day, administrator <span class="wave">✦</span></h1><p>Your workspace is ready. Manage your questions and examinations below.</p></div><div class="admin-avatar">A</div></div>
      <div class="stat-grid">
        <div class="stat-card"><span class="stat-icon lavender">▤</span><div><span class="stat-label">QUESTION BANK</span><strong>${this.questions.length}</strong><small>questions available</small></div><div class="stat-spark spark-purple">⌁</div></div>
        <div class="stat-card"><span class="stat-icon mint">▣</span><div><span class="stat-label">EXAMINATIONS</span><strong>${this.exams.length}</strong><small>${this.exams.filter((exam) => exam.status === 'published').length} published</small></div><div class="stat-spark spark-green">⌁</div></div>
        <div class="stat-card"><span class="stat-icon peach">◉</span><div><span class="stat-label">PARTICIPANTS</span><strong>${this.exams.reduce((sum, exam) => sum + exam.participant_count, 0)}</strong><small>total attempts started</small></div><div class="stat-spark spark-orange">⌁</div></div>
      </div>
      <div class="admin-tabs" role="tablist"><button class=${this.adminTab === 'questions' ? 'active' : ''} @click=${() => { this.adminTab = 'questions'; this.requestUpdate(); }}>Question bank <span>${this.questions.length}</span></button><button class=${this.adminTab === 'exams' ? 'active' : ''} @click=${() => { this.adminTab = 'exams'; this.requestUpdate(); }}>Examinations <span>${this.exams.length}</span></button><button class=${this.adminTab === 'security' ? 'active' : ''} @click=${() => { this.adminTab = 'security'; this.passwordError = ''; this.requestUpdate(); }}>Settings</button></div>
      ${this.adminTab === 'questions' ? html`
        <section class="admin-panel">
          <div class="panel-heading"><div><h2>Question bank</h2><p>Build and organize questions by subject. Every question can include an explanation.</p></div><div class="panel-actions question-bank-actions"><a class="button button-outline" href="/api/admin/questions/template" download>↓ <span>Download Excel template</span></a><label class="excel-subject-picker">Excel default subject <input name="excel_subject" list="subject-options" maxlength="80" placeholder="Optional fallback" /><datalist id="subject-options">${this.questionCategories.map((value) => html`<option value=${value}></option>`)}</datalist></label><label class="button button-outline upload-button">↑ <span>Import Excel</span><input type="file" accept=".xlsx,.xls" @change=${this.importWorkbook} aria-label="Import Excel question file" /></label><button class="button button-outline" @click=${() => { this.bulkImportOpen = !this.bulkImportOpen; this.requestUpdate(); }}>▤ <span>${this.bulkImportOpen ? 'Close paste' : 'Paste questions'}</span></button><button class="button button-primary" @click=${() => this.openQuestionForm()}>＋ <span>Add question</span></button></div></div><p class="excel-import-hint">Excel columns include Question, A–D, Correct Answer, optional Category, Explanation, and Difficulty. A row Category takes precedence over the optional default subject.</p>
          ${this.questionFormOpen ? this.renderQuestionForm() : ''}
          ${this.bulkImportOpen ? this.renderBulkImport() : ''}
          <div class="filter-row"><label class="search-field"><span>⌕</span><input placeholder="Search questions or subjects…" .value=${this.searchText} @input=${(event) => { this.searchText = event.target.value; this.questionPage = 0; this.requestUpdate(); }} /></label>
            <select aria-label="Filter subject" .value=${this.categoryFilter} @change=${(event) => { this.categoryFilter = event.target.value; this.questionPage = 0; this.requestUpdate(); }}><option value="">All subjects</option>${this.questionCategories.map((value) => html`<option value=${value}>${value}</option>`)}</select>
            <select aria-label="Filter difficulty" .value=${this.difficultyFilter} @change=${(event) => { this.difficultyFilter = event.target.value; this.questionPage = 0; this.requestUpdate(); }}><option value="">All difficulties</option>${this.questionDifficulties.map((value) => html`<option value=${value}>${value}</option>`)}</select>
            <span class="results-count">${this.filteredQuestions.length} results</span></div>
          ${this.filteredQuestions.length ? html`<div class="table-scroll"><table class="data-table question-table"><thead><tr><th>QUESTION</th><th>SUBJECT</th><th>DIFFICULTY</th><th>KEY</th><th>STATUS</th><th></th></tr></thead><tbody>${pageQuestions.map((question) => html`<tr><td><div class="question-cell"><span class="question-row-number">${String(question.id).padStart(2, '0')}</span><span title=${question.question_text}>${question.question_text}</span></div></td><td>${question.category || '—'}</td><td>${question.difficulty ? html`<span class="difficulty-tag ${question.difficulty.toLowerCase()}">${question.difficulty}</span>` : '—'}</td><td><span class="answer-key">${question.correct_option}</span></td><td>${question.locked ? html`<span class="lock-tag" title="Existing exams retain their original question version">⌑ In exam</span>` : html`<span class="available-tag">Available</span>`}</td><td class="row-actions"><button aria-label="Edit question" title="Edit question" @click=${() => this.openQuestionForm(question)}>✎</button><button aria-label="Delete question" title="Delete question" @click=${() => this.deleteQuestion(question)}>×</button></td></tr>`)}</tbody></table></div>
            <div class="table-footer"><span>Showing ${this.filteredQuestions.length ? this.questionPage * this.pageSize + 1 : 0}–${Math.min((this.questionPage + 1) * this.pageSize, this.filteredQuestions.length)} of ${this.filteredQuestions.length}</span><div class="pagination"><button ?disabled=${this.questionPage === 0} @click=${() => { this.questionPage -= 1; this.requestUpdate(); }}>←</button><span>${this.questionPage + 1} / ${pageCount}</span><button ?disabled=${this.questionPage >= pageCount - 1} @click=${() => { this.questionPage += 1; this.requestUpdate(); }}>→</button></div></div>` : html`<div class="empty-state"><div class="empty-illustration">⌕</div><h3>No questions found</h3><p>Try changing the filters, import a workbook, or add a question.</p></div>`}
        </section>` : this.adminTab === 'exams' ? this.renderExamsAdmin() : this.renderPasswordSettings()}
    </main>`;
  }

  renderQuestionForm() {
    const q = this.editingQuestion || {};
    return keyed(q.id ?? 'new-question', html`<form class="question-editor" @submit=${this.saveQuestion}><div class="editor-title"><div><span class="eyebrow muted">QUESTION DETAILS</span><h3>${this.editingQuestion ? 'Edit question' : 'Add a question'}</h3></div><button type="button" class="icon-close" @click=${() => { this.questionFormOpen = false; this.requestUpdate(); }}>×</button></div>
      <label class="full-field">Question<input name="question_text" required maxlength="2000" value=${q.question_text || ''} placeholder="Write a clear question" /></label>
      <div class="option-grid">${letters.map((letter) => html`<label>Option ${letter}<input name="option_${letter.toLowerCase()}" required maxlength="500" value=${q[`option_${letter.toLowerCase()}`] || ''} placeholder="Enter option ${letter}" /></label>`)}</div>
      <div class="editor-bottom"><label>Correct answer<select name="correct_option">${letters.map((letter) => html`<option value=${letter} ?selected=${letter === (q.correct_option || 'A')}>Option ${letter}</option>`)}</select></label><label>Subject<input name="category" required maxlength="80" value=${q.category || ''} placeholder="e.g. Geography" /></label><label>Difficulty<select name="difficulty">${['', 'Easy', 'Medium', 'Hard'].map((difficulty) => html`<option value=${difficulty} ?selected=${difficulty === (q.difficulty || '')}>${difficulty || 'Choose…'}</option>`)}</select></label></div>
      <label class="full-field">Explanation <span class="optional-label">OPTIONAL</span><textarea name="explanation" rows="2" maxlength="2000" placeholder="Explain why the correct answer is right">${q.explanation || ''}</textarea></label>
      <div class="editor-actions"><button type="button" class="button button-quiet" @click=${() => { this.questionFormOpen = false; this.requestUpdate(); }}>Cancel</button><button class="button button-primary" ?disabled=${this.busy}>${this.busy ? 'Saving…' : this.editingQuestion ? 'Save changes' : 'Add to question bank'}</button></div>
    </form>`);
  }

  renderBulkImport() {
    return html`<form class="bulk-import-panel stack-form" @submit=${this.importPastedQuestions}>
      <div class="bulk-intro"><div><span class="eyebrow muted">BULK QUESTION UPLOAD</span><h3>Paste up to 300 questions</h3><p>Use the same numbered format for every question, with a blank line between questions.</p></div><span class="bulk-count">1–300</span></div>
      <label>Subject<input name="subject" required maxlength="80" list="subject-options" placeholder="e.g. Biology" /></label>
      <div class="paste-sample"><b>Format sample</b><pre>1. What is the capital of France?\nA. Rome\nB. Paris\nC. Madrid\nD. Berlin\nAnswer: B\nExplanation: Paris is the capital of France.</pre><small>Repeat with 2., 3., and so on. Explanation is optional.</small></div>
      <label>Questions<textarea name="text" required rows="12" spellcheck="false" placeholder="Paste your numbered questions here…"></textarea></label>
      <div class="editor-actions"><button type="button" class="button button-quiet" @click=${() => { this.bulkImportOpen = false; this.requestUpdate(); }}>Cancel</button><button class="button button-primary" ?disabled=${this.busy}>${this.busy ? 'Uploading…' : 'Upload questions'}</button></div>
    </form>`;
  }

  renderPasswordSettings() {
    return html`<div class="settings-grid"><section class="admin-panel password-panel"><div class="panel-heading"><div><h2>Change admin password</h2><p>Choose a new password for your administrator account.</p></div><span class="security-icon">⌑</span></div>
      <form class="stack-form password-form" @submit=${this.changePassword}>
        <label>Current password<input name="current_password" type="password" autocomplete="current-password" required placeholder="Enter your current password" /></label>
        <label>New password<input name="new_password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required placeholder="At least 12 characters" /><small class="field-help">Use 12–128 characters.</small></label>
        <label>Confirm new password<input name="confirm_password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required placeholder="Enter the new password again" /></label>
        ${this.passwordError ? html`<div class="inline-error">${this.passwordError}</div>` : ''}
        <button class="button button-primary" ?disabled=${this.passwordBusy}>${this.passwordBusy ? 'Changing password…' : 'Change password'}</button>
      </form>
    </section><section class="admin-panel backup-panel"><div class="panel-heading"><div><span class="eyebrow">YOUR DATA</span><h2>Database backup</h2></div><span class="security-icon" aria-hidden="true">↓</span></div><p>Keep a copy of your question bank, examinations, and participant records in one download.</p><a class="button button-primary" href="/api/admin/backup" download>↓ Download backup</a><small class="field-help">Includes private participant data and admin credentials. Store the file securely.</small></section></div>`;
  }

  renderExamsAdmin() {
    const selectedQuestions = this.selectionIds.map((id) => this.questions.find((question) => question.id === id)).filter(Boolean);
    const availableForSubject = this.questions.filter((question) => question.category === this.examSubject);
    return html`<section class="exam-admin-layout">
      <div class="admin-panel exam-create-panel"><div class="panel-heading"><div><h2>Create an examination</h2><p>Choose a fixed question set and set your result rules.</p></div><span class="create-spark">✦</span></div>
        <form class="stack-form create-exam-form" @submit=${this.createExam}>
          <div class="field-row"><label>Examination title<input name="title" required maxlength="160" placeholder="e.g. General Knowledge — October" /></label><label>Duration (minutes)<input name="duration_minutes" type="number" min="1" max="1440" value="30" required /></label></div>
          <label>Description <span class="optional-label">OPTIONAL</span><textarea name="description" rows="2" maxlength="500" placeholder="Give students a little context"></textarea></label>
          <fieldset class="selection-fieldset"><legend>Question selection</legend>
            <label class="subject-select-label">Subject<select name="subject" required .value=${this.examSubject} @change=${(event) => { this.examSubject = event.target.value; this.selectionIds = []; this.selectionSearch = ''; this.randomCount = 10; this.requestUpdate(); }}><option value="">Choose a subject…</option>${this.questionCategories.map((value) => html`<option value=${value}>${value}</option>`)}</select></label>
            <div class="selection-switch"><button type="button" class=${this.selectionMode === 'manual' ? 'selected' : ''} @click=${() => { this.selectionMode = 'manual'; this.selectionIds = []; this.requestUpdate(); }}>☷ &nbsp; Manual selection</button><button type="button" class=${this.selectionMode === 'random' ? 'selected' : ''} @click=${() => { this.selectionMode = 'random'; this.selectionIds = []; this.requestUpdate(); }}>⤨ &nbsp; Random selection</button></div>
            ${this.selectionMode === 'manual' ? html`<div class="selection-tools"><span>${this.examSubject ? `${availableForSubject.length} questions in ${this.examSubject}` : 'Choose a subject to load its questions'}</span><label class="compact-search"><span>⌕</span><input placeholder="Find a question…" .value=${this.selectionSearch} ?disabled=${!this.examSubject} @input=${(event) => { this.selectionSearch = event.target.value; this.requestUpdate(); }} /></label></div><div class="selection-list">${this.selectionQuestions.map((question) => html`<label class="selection-item"><input type="checkbox" .checked=${this.selectionIds.includes(question.id)} @change=${(event) => this.toggleSelectedQuestion(question.id, event.target.checked)} /><span class="selection-item-content"><b>${question.question_text}</b><span class="selection-option-grid">${letters.map((letter) => html`<span class=${letter === question.correct_option ? 'selection-correct-option' : ''}><strong>${letter}.</strong> ${question[optionKeys[letter]]}${letter === question.correct_option ? html` <b class="correct-answer-label">✓ Correct answer</b>` : ''}</span>`)}</span>${question.explanation ? html`<small class="selection-explanation">Explanation: ${question.explanation}</small>` : ''}<small>${question.difficulty || 'Difficulty not set'}</small></span></label>`)}</div>` : html`<div class="random-maker"><label>Number of questions<input type="number" min="1" max=${Math.max(1, availableForSubject.length)} .value=${String(this.randomCount)} ?disabled=${!availableForSubject.length} @input=${(event) => { this.randomCount = event.target.value; this.requestUpdate(); }} /></label><button type="button" class="button button-outline" ?disabled=${!availableForSubject.length} @click=${this.regenerateRandom}>⟳ Regenerate selection</button><div class="random-preview"><span class="preview-icon">✧</span><div><b>${this.selectionIds.length ? `${this.selectionIds.length} questions selected` : 'Preview your random selection'}</b><small>${availableForSubject.length ? `Random picks use only ${this.examSubject} questions.` : 'Choose a subject with questions to continue.'}</small></div></div></div>`}
          <div class="selection-footer"><span><b>${this.selectionIds.length}</b> question${this.selectionIds.length === 1 ? '' : 's'} selected</span><span>1 mark each · −${Number(this.querySelector('[name="negative_mark"]')?.value || 1)} for a wrong answer</span></div>
            ${selectedQuestions.length ? html`<div class="selected-questions-preview" aria-label="Full selected question preview">${selectedQuestions.map((q, index) => html`<article class="selected-question-preview"><div class="selected-preview-heading"><span>${String(index + 1).padStart(2, '0')}</span><b>${q.question_text}</b></div><div class="selection-option-grid">${letters.map((letter) => html`<span class=${letter === q.correct_option ? 'selection-correct-option' : ''}><strong>${letter}.</strong> ${q[optionKeys[letter]]}${letter === q.correct_option ? html` <b class="correct-answer-label">✓ Correct answer</b>` : ''}</span>`)}</div>${q.explanation ? html`<small class="selection-explanation">Explanation: ${q.explanation}</small>` : ''}</article>`)}</div>` : ''}
          </fieldset>
          <div class="field-row"><label>Wrong answer penalty<select name="negative_mark" required><option value="1">−1 mark</option><option value="0.25">−0.25 mark</option><option value="0.5">−0.50 mark</option></select><small class="field-help">Unanswered questions receive no penalty.</small></label><label>Initial status<select name="status"><option value="published">Published</option><option value="draft">Draft</option></select></label></div>
          <div class="settings-row"><div class="result-settings"><span class="setting-title">Student results</span><label class="check-setting"><input name="show_score" type="checkbox" @change=${(event) => { const answerBox = this.querySelector('[name="show_answers"]'); if (answerBox) { answerBox.disabled = !event.target.checked; if (!event.target.checked) answerBox.checked = false; } }} /><span><b>Show final score</b><small>Students can see their total mark.</small></span></label><label class="check-setting"><input name="show_answers" type="checkbox" disabled /><span><b>Show answer review</b><small>Students can review correct answers and explanations.</small></span></label></div></div>
          <button class="button button-primary button-full" ?disabled=${this.busy}>${this.busy ? 'Creating examination…' : 'Create examination'} <span aria-hidden="true">→</span></button>
        </form>
      </div>
      <div class="admin-panel exam-list-panel"><div class="panel-heading"><div><h2>Your examinations</h2><p>Review status and participant results.</p></div><span class="exam-total">${this.exams.length}</span></div>
        ${this.exams.length ? html`<div class="admin-exam-list">${this.exams.map((exam) => html`<article class="admin-exam-card"><div class="admin-exam-title"><div class="exam-list-icon">▣</div><div><h3>${exam.title}</h3><p>${exam.subject || 'No subject'} · ${exam.question_count} questions · ${exam.duration_minutes} min · −${Number(exam.negative_mark || 0)} wrong · ${exam.participant_count} participant${exam.participant_count === 1 ? '' : 's'}</p></div><span class="status-tag ${exam.status}">${exam.status}</span></div><div class="exam-list-actions"><label class="status-control">Status <select .value=${exam.status} @change=${(event) => this.changeExamStatus(exam, event.target.value)}><option value="draft">Draft</option><option value="published">Published</option><option value="closed">Closed</option></select></label><button class="button button-outline button-small" ?disabled=${exam.status !== 'published'} @click=${() => this.copyExamLink(exam)}>Copy link</button><a class="button button-quiet button-small" href=${exam.status === 'published' ? this.examUrl(exam) : undefined} ?hidden=${exam.status !== 'published'}>Open ↗</a><button class="button button-outline button-small" @click=${() => this.loadAttempts(exam)}>View results <span>→</span></button><button class="button button-danger button-small" @click=${() => this.deleteExam(exam)}>Delete exam</button></div>
            ${exam.status === 'published' ? html`<div class="exam-share-row"><span>Public exam link</span><a href=${this.examUrl(exam)}>${this.examUrl(exam)}</a></div>` : html`<div class="exam-share-row unavailable-share"><span>Public link available after publishing</span></div>`}
            <div class="exam-visibility"><span>Student results</span><label title="Show final score to students"><input type="checkbox" .checked=${Boolean(exam.show_score)} @change=${(event) => this.changeExamVisibility(exam, 'score', event.target.checked)} /> Show score</label><label title="Show individual answer review to students"><input type="checkbox" .checked=${Boolean(exam.show_answers)} ?disabled=${!exam.show_score} @change=${(event) => this.changeExamVisibility(exam, 'answers', event.target.checked)} /> Show answers</label></div>
            ${this.resultExam?.id === exam.id ? this.renderAttempts(exam) : ''}</article>`)}</div>` : html`<div class="empty-state"><div class="empty-illustration">▣</div><h3>No examinations yet</h3><p>Build one from the question bank to get started.</p></div>`}
      </div>
    </section>`;
  }

  renderAttempts(exam) {
    if (this.answerSheet && this.resultExam?.id === exam.id) return this.renderAnswerSheet();
    return html`<div class="attempts-panel"><div class="attempts-heading"><b>Participants</b><span>${this.attempts.length} attempt${this.attempts.length === 1 ? '' : 's'}</span></div>${this.attempts.length ? html`<div class="attempt-list">${this.attempts.map((attempt) => html`<button class="attempt-row" @click=${() => this.openAnswerSheet(attempt)}><span class="attempt-avatar">${attempt.student_name.slice(0, 1).toUpperCase()}</span><span class="attempt-person"><b>${attempt.student_name}</b><small>Roll ${attempt.roll_number}${attempt.email ? ` · ${attempt.email}` : ''}</small></span><span class="attempt-score">${attempt.score === null ? '—' : `${attempt.score} / ${exam.question_count}`}</span><span class="status-tag ${attempt.status}">${attempt.status.replace('_', ' ')}</span><span class="row-arrow">→</span></button>`)}</div>` : html`<div class="empty-inline">No participants yet. Share the published exam link with students.</div>`}</div>`;
  }

  renderAnswerSheet() {
    const sheet = this.answerSheet;
    const graded = sheet.status !== 'in_progress';
    return html`<div class="answer-sheet"><div class="sheet-header"><div><button class="back-link compact-back" @click=${() => { this.answerSheet = null; this.requestUpdate(); }}>← Participants</button><h3>${sheet.student_name}<span> · Roll ${sheet.roll_number}</span></h3><p>${sheet.exam_title} · ${sheet.email || 'No email provided'} · ${sheet.address || 'No address provided'}</p></div><div class="sheet-score"><b>${sheet.score}</b><small>FINAL SCORE</small></div></div><button class="button button-danger button-small" @click=${() => this.deleteAttempt(sheet)}>Delete answer sheet</button><div class="sheet-meta"><span class="status-tag ${sheet.status}">${sheet.status.replace('_', ' ')}</span><span>Penalty: −${Number(this.resultExam?.negative_mark || 0)} for wrong answers</span><span>Started ${this.formatDate(sheet.started_at)}</span><span>${sheet.submitted_at ? `Submitted ${this.formatDate(sheet.submitted_at)}` : 'Not submitted'}</span></div>
      <div class="sheet-questions">${sheet.answers.map((answer, index) => html`<article class="sheet-question ${graded ? answer.is_correct ? 'is-correct' : 'is-wrong' : 'is-pending'}"><div class="sheet-q-head"><span>QUESTION ${String(index + 1).padStart(2, '0')}</span><span class=${graded ? answer.is_correct ? 'correct-text' : 'wrong-text' : 'pending-text'}>${graded ? answer.is_correct ? '✓ Correct' : answer.selected_option ? '× Incorrect' : 'Not answered' : 'Not graded'}</span></div><h4>${answer.question_text}</h4><div class="sheet-answers">${letters.map((letter) => html`<div class="sheet-option ${letter === answer.correct_option ? 'right-option' : ''} ${graded && letter === answer.selected_option && !answer.is_correct ? 'chosen-wrong' : ''}"><span>${letter}</span><span>${answer[optionKeys[letter]]}</span>${letter === answer.selected_option ? html`<small class="student-label">STUDENT</small>` : ''}${letter === answer.correct_option ? html`<small>CORRECT</small>` : ''}</div>`)}</div>${answer.explanation ? html`<p class="answer-explanation"><b>Explanation</b> ${answer.explanation}</p>` : ''}<div class="marks-row"><span>Student selected <b>${answer.selected_option ? `Option ${answer.selected_option}` : 'No answer'}</b></span><span>${graded ? `${answer.marks_awarded} / ${answer.marks} mark${answer.marks === 1 ? '' : 's'}` : 'Pending submission'}</span></div></article>`)}</div>
      <button class="button button-outline button-full back-sheet-button" @click=${() => { this.answerSheet = null; this.requestUpdate(); }}>← Back to participants</button>
    </div>`;
  }

  formatDate(value) {
    if (!value) return '—';
    const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  renderStartDialog() {
    return html`<div class="modal-backdrop" @click=${(event) => { if (event.target === event.currentTarget) this.dismissStart(); }}><section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="start-title"><button class="icon-close modal-close" @click=${this.dismissStart}>×</button><span class="eyebrow muted">BEFORE YOU BEGIN</span><h2 id="start-title">${this.startingExam.title}</h2><p class="modal-intro">${this.startingExam.question_count} questions · ${this.startingExam.duration_minutes} minutes. Enter your details to begin.</p><div class="start-reminder"><span>◷</span><span>${this.startingExam.loadingDetails ? 'Loading the exam scoring rule…' : `Your timer starts as soon as you begin. A wrong answer loses ${Number(this.startingExam.negative_mark || 0)} mark; unanswered questions receive no penalty.`}</span></div><form class="stack-form" @submit=${this.startExam}><label>Full name<input name="student_name" required maxlength="120" autocomplete="name" placeholder="Your name" /></label><label>Email<input name="email" type="email" required maxlength="254" autocomplete="email" placeholder="you@example.com" /></label><label>Address<input name="address" required maxlength="500" autocomplete="street-address" placeholder="Your address" /></label><label>Roll number<input name="roll_number" required maxlength="60" placeholder="Your roll number" /></label><button class="button button-primary button-full" ?disabled=${this.busy || this.startingExam.loadingDetails}>${this.startingExam.loadingDetails ? 'Loading exam…' : this.busy ? 'Preparing your exam…' : 'Begin examination'} <span>→</span></button></form><button class="text-button modal-cancel" @click=${this.dismissStart}>Maybe later</button></section></div>`;
  }

  renderExam() {
    const question = this.attempt?.questions?.[this.currentQuestion];
    if (!question) return html`<main class="exam-loading"><div class="loader-dot"></div><p>Preparing your examination…</p></main>`;
    const answered = Object.values(this.answers).filter(Boolean).length;
    const total = this.attempt.questions.length;
    const progress = (answered / total) * 100;
    return html`<main class="exam-player">
      <div class="exam-player-top"><button class="brand" @click=${() => { if (window.confirm('Leave this exam? You can return using this browser session.')) this.page = 'home'; }}><span class="brand-mark">N</span><span>northstar<span class="brand-dot">.</span><small>EXAMINATION PORTAL</small></span></button><div class="exam-live-meta"><span class="live-label"><span></span> IN PROGRESS</span><span class="timer-chip ${this.remainingSeconds < 300 ? 'timer-warning' : ''}"><span>◷</span>${htmlTime(this.remainingSeconds)}</span></div></div>
      <div class="exam-player-layout"><aside class="exam-sidebar"><div class="sidebar-exam-info"><span class="eyebrow muted">EXAMINATION</span><h2>${this.attempt.exam_title}</h2><p>${this.attempt.student_name}<span> · Roll ${this.attempt.roll_number}</span></p></div><div class="sidebar-progress"><div><span>YOUR PROGRESS</span><b>${answered} <small>/ ${total}</small></b></div><div class="progress-track"><span style="width:${progress}%"></span></div><p>${answered === total ? 'You have answered every question.' : `${total - answered} questions remaining`}</p></div><div class="question-nav-label"><span>QUESTION NAVIGATOR</span><span>${answered} answered</span></div><div class="question-nav">${this.attempt.questions.map((item, index) => html`<button class="question-nav-item ${index === this.currentQuestion ? 'current' : ''} ${this.answers[item.id] ? 'answered' : ''}" @click=${() => { this.currentQuestion = index; this.requestUpdate(); }} aria-label=${`Question ${index + 1}${this.answers[item.id] ? ', answered' : ''}`}><span>${String(index + 1).padStart(2, '0')}</span>${this.answers[item.id] ? html`<span class="nav-check">✓</span>` : ''}</button>`)}</div><div class="nav-legend"><span><i class="legend-current"></i>Current</span><span><i class="legend-done"></i>Answered</span><span><i class="legend-empty"></i>Unanswered</span></div><div class="autosave-note"><span>✓</span> Answers save as you go</div></aside>
        <section class="question-stage"><div class="question-stage-top"><span>QUESTION <b>${String(this.currentQuestion + 1).padStart(2, '0')}</b> <i>OF</i> ${String(total).padStart(2, '0')}</span><span class="mark-chip">${question.marks} MARK</span></div><div class="question-progress"><span style="width:${((this.currentQuestion + 1) / total) * 100}%"></span></div><div class="question-content"><div class="question-step">${String(this.currentQuestion + 1).padStart(2, '0')} <span>—</span> ${String(total).padStart(2, '0')}</div><h1>${question.question_text}</h1><p class="question-hint">Select one answer to continue</p><div class="answer-options">${letters.map((letter) => html`<button class="answer-option ${this.answers[question.id] === letter ? 'selected' : ''}" @click=${() => this.selectAnswer(question, letter)}><span class="option-letter">${letter}</span><span class="option-text">${question[optionKeys[letter]]}</span><span class="option-radio">${this.answers[question.id] === letter ? html`<i></i>` : ''}</span></button>`)}</div></div><div class="question-actions"><button class="button button-outline" ?disabled=${this.currentQuestion === 0} @click=${() => { this.currentQuestion -= 1; this.requestUpdate(); }}>← <span>Previous</span></button><span class="save-state"><span class="save-dot"></span> ${this.pendingAnswerSaves ? 'Saving…' : 'Saved automatically'}</span>${this.currentQuestion < total - 1 ? html`<button class="button button-primary" @click=${() => { this.currentQuestion += 1; this.requestUpdate(); }}>Next question <span>→</span></button>` : html`<button class="button button-primary" @click=${() => this.submitAttempt(false)} ?disabled=${this.busy}>Submit exam <span>→</span></button>`}</div><button class="submit-text" @click=${() => this.submitAttempt(false)}>Submit examination</button></section>
      </div><footer class="exam-player-footer"><span>Northstar Examination Portal</span><span>Need a moment? Your answers are saved automatically.</span></footer>
    </main>`;
  }

  renderStudentResult() {
    const result = this.attempt?.result || {};
    const reviewed = result.answers || [];
    return html`<main class="result-page"><div class="result-card"><div class="result-success-icon">✓</div><span class="eyebrow muted">EXAMINATION COMPLETE</span><h1>${this.attempt?.exam_title || 'Your examination'}</h1><p class="result-greeting">Well done, ${this.attempt?.student_name || 'student'}.</p><div class="result-message">Your exam has been submitted successfully.</div>
      ${Object.hasOwn(result, 'score') ? html`<div class="student-score"><span>YOUR SCORE</span><strong>${result.score}<small> / ${this.attempt.questions.length}</small></strong><p>${result.status === 'auto_submitted' ? 'Submitted automatically when time expired' : 'Your examination has been submitted'}</p></div>` : ''}
      ${reviewed.length ? html`<div class="student-review"><div class="review-heading"><h2>Answer review</h2><span>${reviewed.filter((answer) => answer.is_correct).length} of ${reviewed.length} correct</span></div>${reviewed.map((answer, index) => html`<article class="review-item ${answer.is_correct ? 'is-correct' : 'is-wrong'}"><div class="review-item-head"><span>QUESTION ${String(index + 1).padStart(2, '0')}</span><b>${answer.is_correct ? '✓ Correct' : answer.selected_option ? '× Incorrect' : 'Not answered'}</b></div><h3>${answer.question_text}</h3><p>Your answer: <strong>${answer.selected_option ? `${answer.selected_option}. ${answer[optionKeys[answer.selected_option]]}` : 'Not answered'}</strong></p><p>Correct answer: <strong>${answer.correct_option}. ${answer[optionKeys[answer.correct_option]]}</strong></p>${answer.explanation ? html`<p class="answer-explanation"><b>Explanation</b> ${answer.explanation}</p>` : ''}<span class="review-mark">${answer.marks_awarded} / ${answer.marks} mark</span></article>`)}</div>` : ''}
      <button class="button button-primary button-full" @click=${this.newAttempt}>Return to examinations <span>→</span></button>
    </div></main>`;
  }
}

customElements.define('mcq-app', McqApp);
