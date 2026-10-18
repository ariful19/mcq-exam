import { LitElement, html } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import './style.css';
import { installMotion, appear, disappear, slideQuestion, setMotionActive, shouldEnableMotion } from './motion.js';
import { filterAndSortResults } from './results.js';
import { generateResultPdf } from './pdf.js';
import {
  QUESTION_TYPES,
  QUESTION_TYPE_OPTIONS,
  DEFAULT_QUESTION_TYPE,
  hydrateQuestionRow,
  getQuestionTypeMeta,
  getRelevantInputsForType,
  createQuestionDraft,
  switchQuestionDraftType,
  confirmPendingTypeSwitch,
  cancelPendingTypeSwitch,
  discardPreservedTypeData,
  revertTypeSwitch,
  addMcqMultiOption,
  removeMcqMultiOption,
  toggleMcqMultiCorrectOption,
  addShortAnswerAccepted,
  removeShortAnswerAccepted,
  addMatchingPrompt,
  removeMatchingPrompt,
  addMatchingChoice,
  removeMatchingChoice,
  addOrderingItem,
  removeOrderingItem,
  moveOrderingItem,
  addFillBlank,
  removeFillBlank,
  addBlankVariant,
  removeBlankVariant,
  sanitizeRichText,
  formatQuestionBlanks,
  cleanQuestionBlanks,
  renderQuestionText,
  syncDraftFromForm,
  validateQuestionDraft,
  formatQuestionTypeBadge,
  formatAnswerKeySummary,
  buildQuestionPreviewModel,
  isAnswerProvided,
  formatStudentAnswerSummary,
  formatCorrectAnswerSummary,
  BULK_PASTE_SAMPLE,
} from './question-authoring.js';

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

export class McqApp extends LitElement {
  createRenderRoot() { return this; }

  constructor() {
    super();
    this.page = 'home';
    this.directExamId = typeof location !== 'undefined' ? (location.pathname.match(/^\/exam\/(\d+)\/?$/)?.[1] || '') : '';
    this.directExam = null;
    this.adminLoggedIn = false;
    this.adminTab = 'questions';
    this.exams = [];
    this.questions = [];
    this.publicExams = [];
    this.selectedExam = null;
    this.attempt = null;
    this.answers = {};
    this.answerDataByQuestion = {};
    this.currentQuestion = 0;
    this.remainingSeconds = 0;
    this.timer = null;
    this.searchText = '';
    this.categoryFilter = '';
    this.difficultyFilter = '';
    this.typeFilter = '';
    this.mediaFilter = '';
    this.attachingMediaQuestion = null;
    this.orderingInitialState = {};
    this.questionPage = 0;
    this.pageSize = 14;
    this.questionFormOpen = false;
    this.bulkImportOpen = false;
    this.editingQuestion = null;
    this.questionDraft = null;
    this.editorPreviewOpen = false;
    this.previewingQuestion = null;
    this.questionSaveError = '';
    this.questionSaveDetails = [];
    this.selectionMode = 'manual';
    this.selectionIds = [];
    this.examSubject = '';
    this.randomCount = 10;
    this.selectionSearch = '';
    this.resultExam = null;
    this.attempts = [];
    this.resultSearch = '';
    this.resultSort = 'recent';
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
    this.shorteningExamId = null;
    this.resumeToken = typeof sessionStorage !== 'undefined' ? (sessionStorage.getItem('mcq-attempt-token') || '') : '';
    this.settings = {
      site_title: 'Northstar',
      site_subtitle: 'EXAMINATION PORTAL',
      hero_eyebrow: 'LEARN · PREPARE · ACHIEVE',
      hero_title: 'Your next step starts here.',
      hero_description: 'Focused assessments, a clear path forward. Choose an examination below when you’re ready.',
      hero_tagline: 'A calm space to do your best work',
      public_url: '',
      enable_short_urls: '0',
      enable_animations: '1',
      auto_device_animations: '1',
      footer_copyright: 'Northstar Examination Portal',
      footer_tagline: 'Thoughtful assessment, made simple ✦',
    };
    this.settingsBusy = false;
    this.settingsError = '';
    this.submitConfirmOpen = false;
  }

  get isShortenerEnabled() {
    return this.settings?.enable_short_urls === '1' || this.settings?.enable_short_urls === 'true' || this.settings?.enable_short_urls === true;
  }

  get isAnimationsEnabled() {
    return this.settings?.enable_animations !== '0' && this.settings?.enable_animations !== 'false' && this.settings?.enable_animations !== false;
  }

  get isAutoDeviceAnimationsEnabled() {
    return this.settings?.auto_device_animations !== '0' && this.settings?.auto_device_animations !== 'false' && this.settings?.auto_device_animations !== false;
  }

  applyMotionSettings() {
    const active = shouldEnableMotion(this.settings);
    setMotionActive(active);
    this.classList.toggle('no-animations', !active);
    if (typeof document !== 'undefined') {
      document.body?.classList.toggle('no-animations', !active);
    }
  }

  connectedCallback() {
    super.connectedCallback();
    this.applyMotionSettings();
    this.stopMotion = installMotion(this);
    this.initialize();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this.timer);
    clearTimeout(this.toastTimer);
    this.stopMotion?.();
    this.messageResolve?.(false);
    this.restoreQuestionScroll();
  }

  updated() {
    const dialog = this.querySelector?.('.question-dialog');
    const previewDialog = this.querySelector?.('.question-preview-dialog');
    const shouldOpenEditor = this.questionFormOpen && this.page === 'admin' && this.adminTab === 'questions';
    const shouldOpenPreview = Boolean(this.previewingQuestion) && !this.questionFormOpen && this.page === 'admin' && this.adminTab === 'questions';

    if (shouldOpenEditor && dialog && !dialog.open) {
      if (previewDialog?.open) previewDialog.close();
      if (this.questionScrollOverflow === undefined) {
        this.questionScrollOverflow = document.body.style.overflow;
      }
      document.body.style.overflow = 'hidden';
      dialog.showModal();
      appear(dialog);
    } else if (!shouldOpenEditor && dialog?.open) {
      dialog.close();
    }

    if (shouldOpenPreview && previewDialog && !previewDialog.open) {
      if (this.questionScrollOverflow === undefined) {
        this.questionScrollOverflow = document.body.style.overflow;
      }
      document.body.style.overflow = 'hidden';
      previewDialog.showModal();
      appear(previewDialog);
    } else if (!shouldOpenPreview && previewDialog?.open) {
      previewDialog.close();
    }

    if (!shouldOpenEditor && !shouldOpenPreview) {
      this.restoreQuestionScroll();
    }
  }

  restoreQuestionScroll() {
    if (this.questionScrollOverflow !== undefined) {
      document.body.style.overflow = this.questionScrollOverflow;
      this.questionScrollOverflow = undefined;
    }
  }

  async closeQuestionForm() {
    if (this.busy || this.closingQuestion) return;
    this.closingQuestion = true;
    await disappear(this.querySelector?.('.question-dialog'));
    this.closingQuestion = false;
    this.questionFormOpen = false;
    this.questionDraft = null;
    this.editorPreviewOpen = false;
    this.questionSaveError = '';
    this.questionSaveDetails = [];
    this.requestUpdate();
  }

  openQuestionPreview(question) {
    if (!question) return;
    this.previewingQuestion = hydrateQuestionRow(question, { includeAnswerKey: true });
    this.requestUpdate();
  }

  async closeQuestionPreview() {
    if (!this.previewingQuestion || this.closingPreview) return;
    this.closingPreview = true;
    await disappear(this.querySelector?.('.question-preview-dialog'));
    this.closingPreview = false;
    this.previewingQuestion = null;
    this.requestUpdate();
  }

  editFromPreview(question = this.previewingQuestion) {
    if (!question) return;
    const previewDialog = this.querySelector?.('.question-preview-dialog');
    if (previewDialog?.open) previewDialog.close();
    this.previewingQuestion = null;
    this.openQuestionForm(question);
  }

  async loadSettings() {
    try {
      const data = await api('/api/settings');
      if (data && typeof data === 'object') {
        this.settings = { ...this.settings, ...data };
        this.applyMotionSettings();
        this.updateDocumentTitle();
        this.requestUpdate();
      }
    } catch { /* Fallback to default settings */ }
  }

  updateDocumentTitle() {
    if (typeof document === 'undefined') return;
    const brand = this.settings.site_title || 'Northstar';
    const subtitle = this.settings.site_subtitle ? ` · ${this.settings.site_subtitle}` : '';
    document.title = `${brand}${subtitle}`;
  }

  async initialize() {
    await this.loadSettings();
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
    const toast = this.toast;
    this.toastTimer = setTimeout(async () => {
      await disappear(this.querySelector?.('.toast'));
      if (this.toast === toast) { this.toast = null; this.requestUpdate(); }
    }, 3600);
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
    this.requestUpdate();
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
      const qType = question.question_type || DEFAULT_QUESTION_TYPE;
      const typeLabel = getQuestionTypeMeta(qType).label.toLowerCase();
      const matchesText = !query || `${question.question_text} ${question.category} ${typeLabel}`.toLowerCase().includes(query);
      const matchesCategory = !this.categoryFilter || question.category === this.categoryFilter;
      const matchesDifficulty = !this.difficultyFilter || question.difficulty === this.difficultyFilter;
      const matchesType = !this.typeFilter || qType === this.typeFilter;
      let matchesMedia = true;
      if (this.mediaFilter === 'pending') {
        matchesMedia = Boolean(question.media && question.media.placeholder);
      } else if (this.mediaFilter === 'with_media') {
        matchesMedia = Boolean(question.media && !question.media.placeholder && question.media.url);
      }
      return matchesText && matchesCategory && matchesDifficulty && matchesType && matchesMedia;
    });
  }

  get selectionQuestions() {
    const query = this.selectionSearch.trim().toLowerCase();
    return this.questions.filter((question) => (!this.examSubject || question.category === this.examSubject)
      && (!query || `${question.question_text} ${question.category}`.toLowerCase().includes(query)));
  }

  get questionCategories() { return [...new Set(this.questions.map((q) => q.category).filter(Boolean))].sort(); }
  get questionDifficulties() { return [...new Set(this.questions.map((q) => q.difficulty).filter(Boolean))].sort(); }

  openQuestionForm(question = null) {
    this.previewingQuestion = null;
    this.editingQuestion = question ? hydrateQuestionRow(question, { includeAnswerKey: true }) : null;
    this.questionDraft = createQuestionDraft(this.editingQuestion);
    this.editorPreviewOpen = false;
    this.questionSaveError = '';
    this.questionSaveDetails = [];
    this.questionFormOpen = true;
    this.error = '';
    this.requestUpdate();
  }

  changeQuestionType(nextType, options = {}) {
    if (!this.questionDraft) {
      this.questionDraft = createQuestionDraft(this.editingQuestion);
    }
    const form = this.querySelector?.('.question-editor');
    if (form) syncDraftFromForm(this.questionDraft, form);
    const result = switchQuestionDraftType(this.questionDraft, nextType, options);
    this.questionSaveError = '';
    this.questionSaveDetails = [];
    this.requestUpdate();
    return result;
  }

  confirmTypeSwitch(discardIncompatible = true) {
    if (!this.questionDraft) return;
    confirmPendingTypeSwitch(this.questionDraft, { discardIncompatible });
    this.questionSaveError = '';
    this.questionSaveDetails = [];
    this.requestUpdate();
  }

  cancelTypeSwitch() {
    if (!this.questionDraft) return;
    cancelPendingTypeSwitch(this.questionDraft);
    this.requestUpdate();
  }

  keepPreservedDraftFields() {
    if (!this.questionDraft) return;
    this.questionDraft.lastSwitchNotice = null;
    this.requestUpdate();
  }

  discardIncompatibleFields(typeToDiscard = this.questionDraft?.lastSwitchNotice?.fromType) {
    if (!this.questionDraft || !typeToDiscard) return;
    discardPreservedTypeData(this.questionDraft, typeToDiscard);
    this.requestUpdate();
  }

  revertQuestionType() {
    if (!this.questionDraft) return;
    revertTypeSwitch(this.questionDraft);
    this.questionSaveError = '';
    this.questionSaveDetails = [];
    this.requestUpdate();
  }

  toggleEditorPreview() {
    if (this.questionDraft) {
      const form = this.querySelector?.('.question-editor');
      if (form) syncDraftFromForm(this.questionDraft, form);
    }
    this.editorPreviewOpen = !this.editorPreviewOpen;
    this.requestUpdate();
  }

  async saveQuestion(event) {
    event?.preventDefault?.();
    this.questionSaveError = '';
    this.questionSaveDetails = [];
    if (!this.questionDraft) {
      this.questionDraft = createQuestionDraft(this.editingQuestion);
    }
    const form = event?.currentTarget || this.querySelector?.('.question-editor');
    if (form) {
      syncDraftFromForm(this.questionDraft, form);
    }

    const { valid, errors, payload } = validateQuestionDraft(this.questionDraft);
    if (!valid) {
      this.questionSaveError = 'Please correct the question details.';
      this.questionSaveDetails = errors;
      this.requestUpdate();
      return null;
    }

    this.busy = true;
    try {
      const saved = await api(this.editingQuestion ? `/api/admin/questions/${this.editingQuestion.id}` : '/api/admin/questions', {
        method: this.editingQuestion ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await disappear(this.querySelector?.('.question-dialog'));
      this.questionFormOpen = false;
      this.questionDraft = null;
      this.editorPreviewOpen = false;
      await this.loadAdminData();
      this.notify(this.editingQuestion ? 'Question updated.' : 'Question added to the bank.');
      return saved;
    } catch (error) {
      this.questionSaveError = error.message || 'Please correct the question details.';
      this.questionSaveDetails = error.details || [];
      return null;
    } finally {
      this.busy = false;
      this.requestUpdate();
    }
  }

  async deleteQuestion(question) {
    if (!await this.confirmMessage('Delete this question from the bank?')) return;
    try {
      await api(`/api/admin/questions/${question.id}`, { method: 'DELETE' });
      await this.loadAdminData();
      this.notify('Question deleted.');
    } catch (error) { this.notify(error.message, 'error'); }
  }

  openQuickAttachMedia(question) {
    this.attachingMediaQuestion = question;
    this.requestUpdate();
  }

  renderQuickAttachModal() {
    const q = this.attachingMediaQuestion;
    if (!q) return '';
    return html`<div class="modal-backdrop" @click=${(e) => { if (e.target === e.currentTarget) { this.attachingMediaQuestion = null; this.requestUpdate(); } }}>
      <section class="modal-card quick-attach-modal" role="dialog" aria-modal="true" aria-labelledby="quick-attach-title">
        <button class="icon-close modal-close" @click=${() => { this.attachingMediaQuestion = null; this.requestUpdate(); }}>×</button>
        <span class="eyebrow muted">ATTACH MEDIA · QUESTION #${q.id}</span>
        <h2 id="quick-attach-title">Attach question media</h2>
        <p class="modal-intro">${q.question_text}</p>
        <form class="stack-form" @submit=${async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const data = new FormData(form);
          const url = String(data.get('url') || '').trim();
          const type = String(data.get('type') || 'image');
          const alt = String(data.get('alt') || '').trim();
          const caption = String(data.get('caption') || '').trim();
          if (!url) {
            this.notify('Please provide a media URL or upload a file.', 'error');
            return;
          }
          this.busy = true;
          try {
            await api(`/api/admin/questions/${q.id}/media`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ media: { type, url, alt, caption } }),
            });
            this.attachingMediaQuestion = null;
            await this.loadAdminData();
            this.notify(`Media attached to Question #${q.id}.`);
          } catch (err) {
            this.notify(err.message, 'error');
          } finally {
            this.busy = false;
            this.requestUpdate();
          }
        }}>
          <div class="field-row">
            <label>Media type
              <select name="type">
                <option value="image">Image</option>
                <option value="audio">Audio clip</option>
              </select>
            </label>
            <label class="button button-outline upload-button" style="align-self: flex-end; margin-bottom: 0;">
              ↑ <span>Upload local file</span>
              <input type="file" accept="image/*,audio/*" style="display:none" @change=${async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const uploadForm = new FormData();
                uploadForm.append('file', file);
                this.busy = true;
                try {
                  const res = await api('/api/admin/media/upload', { method: 'POST', body: uploadForm });
                  const urlInput = this.querySelector?.('.quick-attach-modal [name="url"]');
                  const typeInput = this.querySelector?.('.quick-attach-modal [name="type"]');
                  if (urlInput) urlInput.value = res.url;
                  if (typeInput) typeInput.value = res.type;
                  this.notify('File uploaded. Click Save media attachment to finish.');
                } catch (err) {
                  this.notify(err.message, 'error');
                } finally {
                  this.busy = false;
                  this.requestUpdate();
                }
              }} />
            </label>
          </div>
          <label>Media URL or uploaded path
            <input name="url" required placeholder="https://... or /uploads/..." />
          </label>
          <label>Alt text (for accessibility)
            <input name="alt" placeholder="Describe the image" />
          </label>
          <label>Caption (optional)
            <input name="caption" placeholder="Optional caption" />
          </label>
          <div class="editor-actions">
            <button type="button" class="button button-quiet" @click=${() => { this.attachingMediaQuestion = null; this.requestUpdate(); }}>Cancel</button>
            <button class="button button-primary" ?disabled=${this.busy}>${this.busy ? 'Saving…' : 'Save media attachment'}</button>
          </div>
        </form>
      </section>
    </div>`;
  }

  async importWorkbook(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    const subject = this.querySelector?.('[name="excel_subject"]')?.value.trim();
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

  async copyBulkSample() {
    try {
      await navigator.clipboard.writeText(BULK_PASTE_SAMPLE);
      this.notify('Format sample copied to clipboard.');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = BULK_PASTE_SAMPLE;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      this.notify('Format sample copied to clipboard.');
    }
  }

  loadBulkSample(event) {
    const form = event.currentTarget.closest('form');
    if (form) {
      const textarea = form.querySelector('textarea[name="text"]');
      const subjectInput = form.querySelector('input[name="subject"]');
      if (textarea) textarea.value = BULK_PASTE_SAMPLE;
      if (subjectInput && !subjectInput.value.trim()) subjectInput.value = 'General Knowledge';
      this.notify('Format sample inserted into editor.');
    }
  }

  toggleSelectedQuestion(id, checked) {
    this.selectionIds = checked ? [...this.selectionIds, id] : this.selectionIds.filter((value) => value !== id);
    this.requestUpdate();
  }

  regenerateRandom() {
    const available = this.questions
      .filter((q) => !this.examSubject || q.category === this.examSubject)
      .map((q) => q.id);
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
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    if (this.selectionMode === 'random' && !this.selectionIds.length) this.regenerateRandom();
    const selected = this.selectionIds;
    if (!selected.length) { this.notify('Select at least one available question.', 'error'); return; }
    const selectedQuestions = selected.map((id) => this.questions.find((q) => q.id === id)).filter(Boolean);
    const selectedCategories = [...new Set(selectedQuestions.map((q) => q.category).filter(Boolean))];
    const examSubject = String(values.subject || '').trim() || selectedCategories.join(', ') || 'General';
    const payload = {
      title: values.title, description: values.description, duration_minutes: Number(values.duration_minutes),
      subject: examSubject, negative_mark: Number(values.negative_mark),
      status: values.status, show_score: form.elements.show_score.checked,
      show_answers: form.elements.show_answers.checked,
      allow_pdf_download: Boolean(form.elements.allow_pdf_download?.checked),
      question_ids: selected,
    };
    this.busy = true;
    try {
      const created = await api('/api/admin/exams', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      this.selectionIds = [];
      this.selectionSearch = '';
      this.examSubject = '';
      form.reset();
      await this.loadAdminData();
      if (created.status === 'published') {
        let shareUrl = this.examUrl(created);
        if (this.isShortenerEnabled) {
          try {
            const shortUrl = await this.shortenExam(created);
            if (shortUrl) shareUrl = shortUrl;
          } catch { /* falls back to standard link */ }
        }
        this.notify(`Examination created. Share ${shareUrl} with students.`);
      } else {
        this.notify('Examination created as a draft. Publish it to enable its public link.');
      }
    } catch (error) { this.notify([error.message, ...(error.details || [])].join(' '), 'error'); }
    finally { this.busy = false; this.requestUpdate(); }
  }

  examUrl(exam) {
    const base = this.settings?.public_url?.trim() || (typeof location !== 'undefined' ? location.origin : 'http://127.0.0.1:3000');
    return new URL(`/exam/${exam.id}`, base).href;
  }

  async shortenExam(exam, options = {}) {
    if (exam.status !== 'published') return null;
    this.shorteningExamId = exam.id;
    this.requestUpdate();
    try {
      const payload = {
        url: this.examUrl(exam),
        force: Boolean(options.force),
        shorturl: options.shorturl || undefined,
      };
      const res = await api(`/api/admin/exams/${exam.id}/shorten`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      exam.short_url = res.short_url;
      const target = this.exams.find((e) => e.id === exam.id);
      if (target) target.short_url = res.short_url;
      return res.short_url;
    } catch (err) {
      const msg = [err.message, ...(err.details || [])].filter(Boolean).join(' ');
      throw new Error(msg || 'Could not shorten link');
    } finally {
      this.shorteningExamId = null;
      this.requestUpdate();
    }
  }

  async copyExamLink(exam) {
    if (exam.status !== 'published') return;
    let url = this.examUrl(exam);
    let isShort = false;

    if (this.isShortenerEnabled) {
      if (exam.short_url) {
        url = exam.short_url;
        isShort = true;
      } else {
        try {
          const short = await this.shortenExam(exam);
          if (short) {
            url = short;
            isShort = true;
          }
        } catch (err) {
          this.notify(`Notice: ${err.message}. Copied direct exam link instead.`, 'error');
        }
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      this.notify(isShort ? `Shortened exam link copied: ${url}` : 'Public exam link copied.');
    } catch {
      await this.confirmMessage(isShort ? 'Copy this shortened exam link:' : 'Copy this public exam link:', { value: url, info: true });
    }
  }

  async promptCustomizeShortUrl(exam) {
    const input = window.prompt(
      'Enter custom short URL alias (5-30 letters/numbers/underscores), or leave empty for a random is.gd link:',
      ''
    );
    if (input === null) return;
    try {
      const short = await this.shortenExam(exam, { shorturl: input.trim() || undefined, force: true });
      if (short) {
        await navigator.clipboard.writeText(short).catch(() => {});
        this.notify(`Short link created and copied: ${short}`);
      }
    } catch (err) {
      this.notify(err.message, 'error');
    }
  }

  async saveSettings(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    values.enable_short_urls = form.elements.enable_short_urls?.checked ? '1' : '0';
    values.enable_animations = form.elements.enable_animations?.checked ? '1' : '0';
    values.auto_device_animations = form.elements.auto_device_animations?.checked ? '1' : '0';
    this.settingsBusy = true;
    this.settingsError = '';
    this.requestUpdate();
    try {
      const updated = await api('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      this.settings = { ...this.settings, ...updated };
      this.applyMotionSettings();
      this.updateDocumentTitle();
      this.notify('Portal branding & settings saved successfully.');
    } catch (error) {
      this.settingsError = error.message;
      this.notify(error.message, 'error');
    } finally {
      this.settingsBusy = false;
      this.requestUpdate();
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
      if (status === 'published' && this.isShortenerEnabled && !exam.short_url) {
        this.shortenExam(exam).catch(() => {});
      }
    } catch (error) { this.notify(error.message, 'error'); }
  }

  async changeExamVisibility(exam, field, checked) {
    const showScore = field === 'score' ? checked : Boolean(exam.show_score);
    const showAnswers = field === 'answers' ? checked : Boolean(exam.show_answers);
    const allowPdfDownload = field === 'pdf' ? checked : Boolean(exam.allow_pdf_download);
    const nextShowAnswers = showScore ? showAnswers : false;
    try {
      await api(`/api/admin/exams/${exam.id}/settings`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ show_score: showScore, show_answers: nextShowAnswers, allow_pdf_download: allowPdfDownload }),
      });
      await this.loadAdminData();
      this.notify('Student result visibility updated.');
    } catch (error) { this.notify(error.message, 'error'); }
  }

  async deleteExam(exam) {
    if (!await this.confirmMessage(`Delete "${exam.title}" and all its answer sheets? This cannot be undone.`)) return;
    try {
      await api(`/api/admin/exams/${exam.id}`, { method: 'DELETE' });
      if (this.resultExam?.id === exam.id) { this.resultExam = null; this.answerSheet = null; this.attempts = []; }
      await this.loadAdminData();
      await this.loadPublicExams();
      this.notify('Exam and answer sheets deleted.');
    } catch (error) { this.notify(error.message, 'error'); }
  }

  async deleteAttempt(attempt) {
    if (!await this.confirmMessage(`Delete the result sheet and all saved answers for ${attempt.student_name} (Roll ${attempt.roll_number})? This cannot be undone.`)) return;
    try {
      await api(`/api/admin/attempts/${attempt.id}`, { method: 'DELETE' });
      await this.loadAttempts(this.resultExam);
      await this.loadAdminData();
      this.notify('Result sheet deleted.');
    } catch (error) { this.notify(error.message, 'error'); }
  }

  async loadAttempts(exam) {
    if (this.resultExam?.id !== exam.id) {
      this.resultSearch = '';
      this.resultSort = 'recent';
      this.attempts = [];
    }
    this.resultExam = exam;
    this.answerSheet = null;
    try { this.attempts = await api(`/api/admin/exams/${exam.id}/attempts`); }
    catch (error) { this.notify(error.message, 'error'); }
    this.requestUpdate();
  }

  exportAttemptsCsv(exam) {
    if (!this.attempts?.length) return;
    const headers = ['Roll Number', 'Student Name', 'Email', 'Address', 'Score', 'Total Questions', 'Status', 'Started At', 'Submitted At'];
    const rows = this.attempts.map((attempt) => [
      `"${String(attempt.roll_number || '').replace(/"/g, '""')}"`,
      `"${String(attempt.student_name || '').replace(/"/g, '""')}"`,
      `"${String(attempt.email || '').replace(/"/g, '""')}"`,
      `"${String(attempt.address || '').replace(/"/g, '""')}"`,
      attempt.score === null ? '' : attempt.score,
      exam.question_count || '',
      attempt.status || '',
      attempt.started_at || '',
      attempt.submitted_at || '',
    ]);
    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((row) => row.join(','))].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(exam.title || 'examination').replace(/[^a-z0-9_-]/gi, '_')}-results.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    this.notify('Results exported to CSV.');
  }

  downloadResultPdf(sheet = null) {
    try {
      if (sheet) {
        generateResultPdf({
          attempt: sheet,
          result: {
            status: sheet.status,
            score: sheet.score,
            submittedAt: sheet.submitted_at,
            answers: sheet.answers,
          },
          settings: this.settings,
        });
        this.notify('Answer sheet downloaded as PDF.');
        return;
      }
      if (!this.attempt) return;
      generateResultPdf({
        attempt: this.attempt,
        result: this.attempt.result || {},
        settings: this.settings,
      });
      this.notify('Result sheet downloaded as PDF.');
    } catch (error) {
      this.notify(error.message || 'Failed to generate PDF.', 'error');
    }
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
      if (typeof sessionStorage !== 'undefined') sessionStorage.setItem('mcq-attempt-token', result.token);
      this.startingExam = null;
      await this.loadAttempt(result.token);
    } catch (error) { this.notify(error.message, 'error'); }
    finally { this.busy = false; this.requestUpdate(); }
  }

  async loadAttempt(token, expectedExamId = '') {
    const result = await api(`/api/attempts/${encodeURIComponent(token)}`);
    if (expectedExamId && String(result.exam_id) !== String(expectedExamId)) {
      if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem('mcq-attempt-token');
      this.resumeToken = '';
      return false;
    }
    this.attempt = result;
    const questionById = new Map((result.questions || []).map((q) => [q.id, q]));
    const nextAnswers = {};
    const nextAnswerData = {};
    for (const ans of result.answers || []) {
      const q = questionById.get(ans.question_id);
      const qType = q?.question_type || DEFAULT_QUESTION_TYPE;
      nextAnswerData[ans.question_id] = ans.answer_data || (ans.selected_option ? { selected_option: ans.selected_option } : null);
      if (qType === QUESTION_TYPES.MCQ_SINGLE) {
        nextAnswers[ans.question_id] = ans.selected_option || ans.answer_data?.selected_option || null;
      } else {
        nextAnswers[ans.question_id] = isAnswerProvided(q, ans.selected_option, ans.answer_data) ? (ans.answer_data || true) : null;
      }
    }
    this.answers = nextAnswers;
    this.answerDataByQuestion = nextAnswerData;
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
    this.answerDataByQuestion = {
      ...this.answerDataByQuestion,
      [question.id]: selectedOption ? { selected_option: selectedOption } : null,
    };
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

  async saveStructuredAnswer(question, answerData) {
    if (this.busy || this.attempt?.status !== 'in_progress') return;
    const provided = isAnswerProvided(question, null, answerData);
    this.answerDataByQuestion = {
      ...this.answerDataByQuestion,
      [question.id]: provided ? answerData : null,
    };
    this.answers = {
      ...this.answers,
      [question.id]: provided ? answerData : null,
    };
    this.pendingAnswerSaves += 1;
    this.requestUpdate();
    const token = this.resumeToken;
    const save = this.answerSaveQueue.catch(() => {}).then(() => api(`/api/attempts/${encodeURIComponent(token)}/answers`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question_id: question.id, answer_data: provided ? answerData : null }),
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
      this.submitConfirmOpen = true;
      this.requestUpdate();
      return;
    }
    await this.executeSubmitAttempt(true);
  }

  async executeSubmitAttempt(auto = false) {
    if (this.busy || this.attempt?.status !== 'in_progress') return;
    this.busy = true;
    if (this.submitConfirmOpen) await disappear(this.querySelector?.('.confirm-modal'));
    this.submitConfirmOpen = false;
    this.requestUpdate();
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
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem('mcq-attempt-token');
    this.resumeToken = '';
    this.attempt = null;
    this.answers = {};
    this.answerDataByQuestion = {};
    this.page = 'home';
    this.directExam = null;
    this.directExamId = '';
    if (typeof location !== 'undefined' && location.pathname !== '/') history.replaceState({}, '', '/');
    this.loadPublicExams();
  }

  async dismissStart() {
    await disappear(this.querySelector?.('.modal-card'));
    this.startingExam = null; this.requestUpdate();
  }

  async closeSubmitConfirm() {
    await disappear(this.querySelector?.('.confirm-modal'));
    this.submitConfirmOpen = false; this.requestUpdate();
  }

  async goToQuestion(index) {
    if (this.questionMoving || index === this.currentQuestion || index < 0 || index >= this.attempt.questions.length) return;
    this.questionMoving = true;
    try {
      await slideQuestion(this.querySelector?.('.question-content'), Math.sign(index - this.currentQuestion), async () => {
        if (this.page !== 'exam') return;
        this.currentQuestion = index; this.requestUpdate(); await this.updateComplete;
      });
    } finally { this.questionMoving = false; }
  }

  async confirmMessage(message, options = {}) {
    if (this.messageResolve) return false;
    this.messageFocus = typeof document !== 'undefined' ? document.activeElement : null;
    this.customMessage = { message, ...options };
    const result = new Promise(resolve => { this.messageResolve = resolve; });
    this.requestUpdate(); await this.updateComplete;
    const dialog = this.querySelector?.('.message-dialog');
    dialog?.showModal?.(); appear(dialog);
    dialog?.querySelector?.('button')?.focus?.();
    return result;
  }

  async resolveMessage(value) {
    if (this.messageClosing) return;
    this.messageClosing = true;
    await disappear(this.querySelector?.('.message-dialog'));
    this.querySelector?.('.message-dialog')?.close?.();
    this.customMessage = null;
    const resolve = this.messageResolve; this.messageResolve = null;
    this.messageClosing = false;
    this.requestUpdate(); this.messageFocus?.focus?.(); resolve?.(value);
  }

  renderCustomMessage() {
    if (!this.customMessage) return '';
    const message = this.customMessage;
    return html`<dialog class="message-dialog" aria-labelledby="message-title" @cancel=${event => { event.preventDefault(); this.resolveMessage(false); }}>
      <div class="message-icon">${message.info ? '↗' : '?'}</div>
      <h2 id="message-title">${message.info ? 'Public examination link' : 'Please confirm'}</h2>
      <p>${message.message}</p>
      ${message.value ? html`<input aria-label="Public exam link" readonly .value=${message.value} @focus=${event => event.target.select()} />` : ''}
      <div class="confirm-actions">
        ${!message.info ? html`<button class="button button-outline" @click=${() => this.resolveMessage(false)}>Cancel</button>` : ''}
        <button class="button ${message.info ? 'button-primary' : 'button-danger'}" @click=${() => this.resolveMessage(true)}>${message.info ? 'Done' : message.label || 'Delete'}</button>
      </div>
    </dialog>`;
  }

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
        <dialog class="question-dialog" aria-labelledby="question-editor-title"
          @cancel=${(event) => { event.preventDefault(); this.closeQuestionForm(); }}
          @click=${(event) => {
            if (event.target !== event.currentTarget) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) this.closeQuestionForm();
          }}>
          ${this.questionFormOpen ? this.renderQuestionForm() : ''}
        </dialog>
        <dialog class="question-preview-dialog" aria-labelledby="question-preview-title"
          @cancel=${(event) => { event.preventDefault(); this.closeQuestionPreview(); }}
          @click=${(event) => {
            if (event.target !== event.currentTarget) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) this.closeQuestionPreview();
          }}>
          ${this.previewingQuestion ? this.renderQuestionPreviewModal() : ''}
        </dialog>
        ${this.renderCustomMessage()}
        ${this.startingExam ? this.renderStartDialog() : ''}
        ${this.submitConfirmOpen ? this.renderSubmitConfirmDialog() : ''}
        ${this.attachingMediaQuestion ? this.renderQuickAttachModal() : ''}
        ${this.toast ? keyed(this.toast, html`<div class="toast ${this.toast.kind}" role="status"><b>${this.toast.message}</b>${this.toast.details?.length ? html`<ul>${this.toast.details.map((detail) => html`<li>${detail}</li>`)}</ul>` : ''}</div>`) : ''}
      </div>
    `;
  }

  renderHeader() {
    const title = this.settings.site_title || 'Northstar';
    const subtitle = this.settings.site_subtitle || 'EXAMINATION PORTAL';
    const mark = title.charAt(0).toUpperCase();
    return html`<header class="site-header">
      <button class="brand" @click=${this.newAttempt} aria-label="${title} home"><span class="brand-mark">${mark}</span><span>${title.toLowerCase()}<span class="brand-dot">.</span><small>${subtitle.toUpperCase()}</small></span></button>
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
          <span class="eyebrow"><span class="eyebrow-line"></span> ${this.settings.hero_eyebrow || 'LEARN · PREPARE · ACHIEVE'}</span>
          <h1>${this.settings.hero_title || 'Your next step starts here.'}</h1>
          <p>${this.settings.hero_description || 'Focused assessments, a clear path forward. Choose an examination below when you’re ready.'}</p>
          <div class="welcome-foot"><span class="soft-icon">✦</span> ${this.settings.hero_tagline || 'A calm space to do your best work'}</div>
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
      <footer class="page-footer"><span>© ${new Date().getFullYear()} ${this.settings.footer_copyright || 'Northstar Examination Portal'}</span><span>${this.settings.footer_tagline || 'Thoughtful assessment, made simple ✦'}</span></footer>
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
    </section><footer class="login-footer">${(this.settings.site_title || 'NORTHSTAR').toUpperCase()} · ${(this.settings.site_subtitle || 'EXAMINATION PORTAL').toUpperCase()}</footer></main>`;
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
      </div><footer class="login-footer">${(this.settings.site_title || 'NORTHSTAR').toUpperCase()} · ${(this.settings.site_subtitle || 'EXAMINATION PORTAL').toUpperCase()}</footer>
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
          <div class="panel-heading"><div><h2>Question bank</h2><p>Build and organize questions by subject and question type. Every question can be previewed, edited, and explained.</p></div><div class="panel-actions question-bank-actions"><a class="button button-outline" href="/api/admin/questions/template" download>↓ <span>Download Excel template</span></a><label class="excel-subject-picker">Excel default subject <input name="excel_subject" list="subject-options" maxlength="80" placeholder="Optional fallback" /><datalist id="subject-options">${this.questionCategories.map((value) => html`<option value=${value}></option>`)}</datalist></label><label class="button button-outline upload-button">↑ <span>Import Excel</span><input type="file" accept=".xlsx,.xls" @change=${this.importWorkbook} aria-label="Import Excel question file" /></label><button class="button button-outline" @click=${() => { this.bulkImportOpen = !this.bulkImportOpen; this.requestUpdate(); }}>▤ <span>${this.bulkImportOpen ? 'Close paste' : 'Paste questions'}</span></button><button class="button button-primary" @click=${() => this.openQuestionForm()}>＋ <span>Add question</span></button></div></div><p class="excel-import-hint">Excel columns include Question, A–D, Correct Answer, optional Category, Explanation, Difficulty, and optional Question Type, Question Config, Answer Key, and Media.</p>

          ${this.bulkImportOpen ? this.renderBulkImport() : ''}
          <div class="filter-row"><label class="search-field"><span>⌕</span><input placeholder="Search questions, subjects, or types…" .value=${this.searchText} @input=${(event) => { this.searchText = event.target.value; this.questionPage = 0; this.requestUpdate(); }} /></label>
            <select aria-label="Filter question type" .value=${this.typeFilter} @change=${(event) => { this.typeFilter = event.target.value; this.questionPage = 0; this.requestUpdate(); }}><option value="">All types</option>${QUESTION_TYPE_OPTIONS.map((opt) => html`<option value=${opt.value}>${opt.shortLabel}</option>`)}</select>
            <select aria-label="Filter media" .value=${this.mediaFilter} @change=${(event) => { this.mediaFilter = event.target.value; this.questionPage = 0; this.requestUpdate(); }}><option value="">All media</option><option value="pending">Pending media ⚠️</option><option value="with_media">With media</option></select>
            <select aria-label="Filter subject" .value=${this.categoryFilter} @change=${(event) => { this.categoryFilter = event.target.value; this.questionPage = 0; this.requestUpdate(); }}><option value="">All subjects</option>${this.questionCategories.map((value) => html`<option value=${value}>${value}</option>`)}</select>
            <select aria-label="Filter difficulty" .value=${this.difficultyFilter} @change=${(event) => { this.difficultyFilter = event.target.value; this.questionPage = 0; this.requestUpdate(); }}><option value="">All difficulties</option>${this.questionDifficulties.map((value) => html`<option value=${value}>${value}</option>`)}</select>
            <span class="results-count">${this.filteredQuestions.length} results</span></div>
          ${this.filteredQuestions.length ? html`<div class="table-scroll"><table class="data-table question-table"><thead><tr><th>QUESTION</th><th>TYPE</th><th>SUBJECT</th><th>DIFFICULTY</th><th>KEY</th><th>STATUS</th><th></th></tr></thead><tbody>${pageQuestions.map((question) => {
            const typeBadge = formatQuestionTypeBadge(question);
            const keySummary = formatAnswerKeySummary(question);
            return html`<tr><td><div class="question-cell"><span class="question-row-number">${String(question.id).padStart(2, '0')}</span><span title=${cleanQuestionBlanks(question.question_text)}>${unsafeHTML(renderQuestionText(question.question_text))}</span>${question.media?.placeholder ? html`<span class="media-placeholder-indicator" title="Pending media attachment">⚠️ Pending media</span>` : question.media?.type ? html`<span class="media-indicator" title=${`Includes ${question.media.type} media`}>${question.media.type === 'audio' ? '♪' : '🖼'}</span>` : ''}</div></td><td><span class="question-type-pill type-${question.question_type || 'mcq_single'}">${typeBadge.shortLabel}</span></td><td>${question.category || '—'}</td><td>${question.difficulty ? html`<span class="difficulty-tag ${question.difficulty.toLowerCase()}">${question.difficulty}</span>` : '—'}</td><td><span class="answer-key" title=${formatCorrectAnswerSummary(question)}>${keySummary}</span></td><td>${question.locked ? html`<span class="lock-tag" title="Existing exams retain their original question version">⌑ In exam</span>` : html`<span class="available-tag">Available</span>`}</td><td class="row-actions">${question.media?.placeholder ? html`<button type="button" class="attach-media-btn" aria-label="Attach media" title="Quick attach media file" @click=${() => this.openQuickAttachMedia(question)}>📎</button>` : ''}<button type="button" aria-label="Preview question" title="Preview question" @click=${() => this.openQuestionPreview(question)}>👁</button><button type="button" aria-label="Edit question" title="Edit question" @click=${() => this.openQuestionForm(question)}>✎</button><button type="button" aria-label="Delete question" title="Delete question" @click=${() => this.deleteQuestion(question)}>×</button></td></tr>`;
          })}</tbody></table></div>
            <div class="table-footer"><span>Showing ${this.filteredQuestions.length ? this.questionPage * this.pageSize + 1 : 0}–${Math.min((this.questionPage + 1) * this.pageSize, this.filteredQuestions.length)} of ${this.filteredQuestions.length}</span><div class="pagination"><button ?disabled=${this.questionPage === 0} @click=${() => { this.questionPage -= 1; this.requestUpdate(); }}>←</button><span>${this.questionPage + 1} / ${pageCount}</span><button ?disabled=${this.questionPage >= pageCount - 1} @click=${() => { this.questionPage += 1; this.requestUpdate(); }}>→</button></div></div>` : html`<div class="empty-state"><div class="empty-illustration">⌕</div><h3>No questions found</h3><p>Try changing the filters, import a workbook, or add a question.</p></div>`}
        </section>` : this.adminTab === 'exams' ? this.renderExamsAdmin() : this.renderPasswordSettings()}
    </main>`;
  }

  renderQuestionForm() {
    if (!this.questionDraft) {
      this.questionDraft = createQuestionDraft(this.editingQuestion);
    }
    const draft = this.questionDraft;
    const qType = draft.question_type || DEFAULT_QUESTION_TYPE;
    const typeMeta = getQuestionTypeMeta(qType);
    const relevantInfo = getRelevantInputsForType(qType);

    return keyed(draft.id ?? 'new-question', html`<form class="question-editor" data-question-type="${qType}" data-relevant-sections="${relevantInfo.sections.join(',')}" @submit=${this.saveQuestion} novalidate>
      <div class="editor-title">
        <div>
          <span class="eyebrow muted">QUESTION DETAILS · ${typeMeta.shortLabel.toUpperCase()}</span>
          <h3 id="question-editor-title">${this.editingQuestion ? 'Edit question' : 'Add a question'}</h3>
        </div>
        <div class="editor-header-actions">
          ${draft.locked ? html`<span class="lock-tag" title="Editing creates a new question version while existing exams keep their original snapshot">⌑ In exam (new version on save)</span>` : ''}
          <button type="button" class="button button-outline button-small preview-toggle-btn" aria-pressed=${String(Boolean(this.editorPreviewOpen))} @click=${() => this.toggleEditorPreview()}>
            👁 <span>${this.editorPreviewOpen ? 'Hide preview' : 'Preview question'}</span>
          </button>
          <button type="button" class="icon-close" aria-label="Close question editor" ?disabled=${this.busy} @click=${this.closeQuestionForm}>×</button>
        </div>
      </div>

      <div class="editor-top-grid">
        <label class="question-type-field">
          Question type
          <select name="question_type" aria-label="Question type" .value=${qType} @change=${(event) => this.changeQuestionType(event.target.value)}>
            ${QUESTION_TYPE_OPTIONS.map((opt) => html`<option value=${opt.value} ?selected=${opt.value === qType}>${opt.label}</option>`)}
          </select>
          <small class="field-help">${typeMeta.description}</small>
        </label>
        <label>
          Subject
          <input name="category" required maxlength="80" list="subject-options" .value=${draft.category} @input=${(event) => { draft.category = event.target.value; this.requestUpdate(); }} placeholder="e.g. Geography" />
        </label>
        <label>
          Difficulty
          <select name="difficulty" .value=${draft.difficulty} @change=${(event) => { draft.difficulty = event.target.value; this.requestUpdate(); }}>
            ${['', 'Easy', 'Medium', 'Hard'].map((difficulty) => html`<option value=${difficulty} ?selected=${difficulty === (draft.difficulty || '')}>${difficulty || 'Choose…'}</option>`)}
          </select>
        </label>
      </div>

      ${draft.pendingTypeSwitch ? this.renderPendingTypeSwitchPrompt(draft.pendingTypeSwitch) : ''}
      ${!draft.pendingTypeSwitch && draft.lastSwitchNotice ? this.renderTypeSwitchPreservedBanner(draft.lastSwitchNotice) : ''}

      <label class="full-field">
        Question prompt
        <input autofocus name="question_text" required maxlength="2000" .value=${draft.question_text} @input=${(event) => { draft.question_text = event.target.value; this.requestUpdate(); }} placeholder="Write a clear question" />
      </label>

      ${this.renderTypeSpecificEditorSection(draft)}

      <fieldset class="type-fieldset stimulus-fieldset" data-section="stimulus">
        <legend>Shared stimulus / Reading passage <span class="optional-label">OPTIONAL · PASSAGE OR AUDIO</span></legend>
        <div class="stimulus-editor-grid">
          <label>
            Stimulus title <span class="optional-label">OPTIONAL</span>
            <input name="stimulus_title" maxlength="200" .value=${draft.stimulus?.title || ''} @input=${(e) => {
              if (!draft.stimulus) draft.stimulus = { enabled: true };
              draft.stimulus.title = e.target.value;
              draft.stimulus.enabled = Boolean(draft.stimulus.title || draft.stimulus.text || draft.stimulus.media_url);
              this.requestUpdate();
            }} placeholder="e.g. Reading passage 1" />
          </label>
          <label class="full-field">
            Stimulus text / passage <span class="optional-label">OPTIONAL · SUPPORTS FORMATTING</span>
            <textarea name="stimulus_text" rows="3" maxlength="4000" .value=${draft.stimulus?.text || ''} @input=${(e) => {
              if (!draft.stimulus) draft.stimulus = { enabled: true };
              draft.stimulus.text = e.target.value;
              draft.stimulus.enabled = Boolean(draft.stimulus.title || draft.stimulus.text || draft.stimulus.media_url);
              this.requestUpdate();
            }} placeholder="Enter the reading passage, scenario, or context">${draft.stimulus?.text || ''}</textarea>
          </label>
          <div class="type-subgrid two-col">
            <label>
              Stimulus media URL <span class="optional-label">OPTIONAL</span>
              <input name="stimulus_media_url" maxlength="2048" .value=${draft.stimulus?.media_url || ''} @input=${(e) => {
                if (!draft.stimulus) draft.stimulus = { enabled: true };
                draft.stimulus.media_url = e.target.value;
                draft.stimulus.enabled = Boolean(draft.stimulus.title || draft.stimulus.text || draft.stimulus.media_url);
                this.requestUpdate();
              }} placeholder="https://... image or audio" />
            </label>
            <label>
              Stimulus media type
              <select name="stimulus_media_type" .value=${draft.stimulus?.media_type || 'image'} @change=${(e) => {
                if (!draft.stimulus) draft.stimulus = { enabled: true };
                draft.stimulus.media_type = e.target.value;
                this.requestUpdate();
              }}>
                <option value="image">Image</option>
                <option value="audio">Audio clip</option>
              </select>
            </label>
          </div>
        </div>
      </fieldset>

      <fieldset class="type-fieldset media-fieldset" data-section="media">
        <legend>Question media <span class="optional-label">OPTIONAL · IMAGE OR AUDIO</span></legend>
        <div class="media-editor-grid">
          <label>
            Attachment type
            <select name="media_mode" aria-label="Attachment type" .value=${draft.media.enabled ? draft.media.type : 'none'} @change=${(event) => {
              const val = event.target.value;
              if (val === 'none') {
                draft.media.enabled = false;
              } else {
                draft.media.enabled = true;
                draft.media.type = val;
              }
              this.requestUpdate();
            }}>
              <option value="none" ?selected=${!draft.media.enabled}>No media</option>
              <option value="image" ?selected=${draft.media.enabled && draft.media.type === 'image'}>Image (URL or data URI)</option>
              <option value="audio" ?selected=${draft.media.enabled && draft.media.type === 'audio'}>Audio clip (URL or data URI)</option>
            </select>
          </label>
          ${draft.media.enabled ? html`
            <label class="media-url-field">
              ${draft.media.type === 'audio' ? 'Audio URL' : 'Image URL'}
              <input name="media_url" required maxlength="2048" .value=${draft.media.url} @input=${(event) => { draft.media.url = event.target.value; this.requestUpdate(); }} placeholder="https://example.com/asset.png or /assets/clip.mp3" />
            </label>
            <label class="button button-outline upload-button" style="align-self: flex-end; margin-bottom: 0;">
              ↑ <span>Upload local file</span>
              <input type="file" accept="image/*,audio/*" style="display:none" @change=${async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const form = new FormData();
                form.append('file', file);
                this.busy = true;
                try {
                  const res = await api('/api/admin/media/upload', { method: 'POST', body: form });
                  draft.media.url = res.url;
                  draft.media.type = res.type;
                  this.notify('File uploaded successfully.');
                } catch (err) {
                  this.notify(err.message, 'error');
                } finally {
                  this.busy = false;
                  this.requestUpdate();
                }
              }} />
            </label>
            ${draft.media.type === 'image' ? html`
              <label>
                Alt text <span class="optional-label">ACCESSIBILITY</span>
                <input name="media_alt" maxlength="500" .value=${draft.media.alt} @input=${(event) => { draft.media.alt = event.target.value; this.requestUpdate(); }} placeholder="Describe the image for screen readers" />
              </label>
            ` : ''}
            <label>
              Caption <span class="optional-label">OPTIONAL</span>
              <input name="media_caption" maxlength="500" .value=${draft.media.caption} @input=${(event) => { draft.media.caption = event.target.value; this.requestUpdate(); }} placeholder="Optional media caption" />
            </label>
          ` : ''}
        </div>
      </fieldset>

      <label class="full-field">
        Explanation <span class="optional-label">OPTIONAL</span>
        <textarea name="explanation" rows="2" maxlength="2000" .value=${draft.explanation} @input=${(event) => { draft.explanation = event.target.value; this.requestUpdate(); }} placeholder="Explain why the correct answer is right">${draft.explanation}</textarea>
      </label>

      ${this.editorPreviewOpen ? html`
        <section class="editor-live-preview" aria-label="Live question preview">
          <div class="live-preview-header">
            <span class="eyebrow">LIVE AUTHORING PREVIEW</span>
            <small>Updates automatically as you edit</small>
          </div>
          ${this.renderQuestionPreviewCard(buildQuestionPreviewModel(draft), { isLiveDraft: true })}
        </section>
      ` : ''}

      ${this.questionSaveError ? html`
        <div class="question-save-error" role="alert">
          <b>${this.questionSaveError}</b>
          ${this.questionSaveDetails?.length ? html`<ul>${this.questionSaveDetails.map((err) => html`<li>${err}</li>`)}</ul>` : ''}
        </div>
      ` : ''}

      <div class="editor-actions">
        <button type="button" class="button button-quiet" ?disabled=${this.busy} @click=${this.closeQuestionForm}>Cancel</button>
        <button type="submit" class="button button-primary" ?disabled=${this.busy}>${this.busy ? 'Saving…' : this.editingQuestion ? 'Save changes' : 'Add to question bank'}</button>
      </div>
    </form>`);
  }

  renderPendingTypeSwitchPrompt(pending) {
    const fromMeta = getQuestionTypeMeta(pending.fromType);
    const toMeta = getQuestionTypeMeta(pending.toType);
    return html`<div class="type-switch-banner warning" role="alertdialog" aria-label="Confirm question type switch">
      <div class="type-switch-copy">
        <b>Switch from ${fromMeta.shortLabel} to ${toMeta.shortLabel}?</b>
        <p>The following populated fields do not apply to ${toMeta.shortLabel}: <strong>${pending.incompatibleFields.join(', ')}</strong>. You can keep them preserved in your draft or discard them.</p>
      </div>
      <div class="type-switch-actions">
        <button type="button" class="button button-outline button-small" data-action="confirm-preserve" @click=${() => this.confirmTypeSwitch(false)}>Switch & preserve draft</button>
        <button type="button" class="button button-danger button-small" data-action="confirm-discard" @click=${() => this.confirmTypeSwitch(true)}>Discard incompatible fields</button>
        <button type="button" class="button button-quiet button-small" data-action="cancel-switch" @click=${() => this.cancelTypeSwitch()}>Cancel</button>
      </div>
    </div>`;
  }

  renderTypeSwitchPreservedBanner(notice) {
    const fromMeta = getQuestionTypeMeta(notice.fromType);
    const toMeta = getQuestionTypeMeta(notice.toType);
    return html`<div class="type-switch-banner" role="region" aria-label="Draft preservation notice">
      <div class="type-switch-copy">
        <b>Draft preserved on switch from ${fromMeta.shortLabel} to ${toMeta.shortLabel}</b>
        <p>Your ${fromMeta.shortLabel} inputs (<strong>${notice.incompatibleFields.join(', ')}</strong>) are kept in memory if you switch back, or you can discard them now.</p>
      </div>
      <div class="type-switch-actions">
        <button type="button" class="button button-outline button-small" data-action="keep-draft" @click=${() => this.keepPreservedDraftFields()}>Keep in draft</button>
        <button type="button" class="button button-outline button-small" data-action="revert-type" @click=${() => this.revertQuestionType()}>Revert to ${fromMeta.shortLabel}</button>
        <button type="button" class="button button-danger button-small" data-action="discard-incompatible" @click=${() => this.discardIncompatibleFields(notice.fromType)}>Discard ${fromMeta.shortLabel} fields</button>
      </div>
    </div>`;
  }

  renderTypeSpecificEditorSection(draft) {
    const qType = draft.question_type || DEFAULT_QUESTION_TYPE;
    const td = draft.typeData[qType];

    if (qType === QUESTION_TYPES.MCQ_SINGLE) {
      return html`<fieldset class="type-fieldset" data-type-section="mcq_single">
        <legend>Single-choice options (A–D) & answer key</legend>
        <div class="option-grid">
          ${letters.map((letter) => {
            const key = `option_${letter.toLowerCase()}`;
            return html`<label>Option ${letter}
              <input name="${key}" required maxlength="500" .value=${td[key] || ''} @input=${(event) => { td[key] = event.target.value; this.requestUpdate(); }} placeholder="Enter option ${letter}" />
            </label>`;
          })}
        </div>
        <div class="single-answer-row">
          <label>Correct answer
            <select name="correct_option" .value=${td.correct_option || 'A'} @change=${(event) => { td.correct_option = event.target.value; this.requestUpdate(); }}>
              ${letters.map((letter) => html`<option value=${letter} ?selected=${letter === (td.correct_option || 'A')}>Option ${letter}</option>`)}
            </select>
          </label>
        </div>
      </fieldset>`;
    }

    if (qType === 'yes_no') {
      const correct = td.correct_answer || 'yes';
      return html`<fieldset class="type-fieldset" data-type-section="yes_no">
        <legend>Yes / No answer key</legend>
        <small class="field-help">Choose the correct response for this question.</small>
        <div class="tf-toggle-row" role="radiogroup" aria-label="Correct Yes or No answer">
          ${[{ id: 'yes', text: 'Yes' }, { id: 'no', text: 'No' }].map((option) => html`<label class="tf-choice-card ${correct === option.id ? 'selected' : ''}">
            <input type="radio" name="yes_no_correct_answer" value=${option.id} style="width:auto;min-height:auto;padding:0;border:0;box-shadow:none" .checked=${correct === option.id} @change=${() => { td.correct_answer = option.id; this.requestUpdate(); }} />
            <span><b>${option.text}</b></span>
          </label>`)}
        </div>
      </fieldset>`;
    }

    if (qType === QUESTION_TYPES.MCQ_MULTI) {
      return html`<fieldset class="type-fieldset" data-type-section="mcq_multi">
        <legend>Multiple-select options & answer key</legend>
        <div class="type-section-head">
          <small class="field-help">Provide 2 to 8 options and check every correct option. Partial credit is the correct selections ÷ correct options minus incorrect selections ÷ incorrect options, multiplied by the question marks (minimum zero, capped at full marks). If there are no incorrect options, there is no incorrect-selection deduction. No exam negative-mark penalty applies.</small>
          <button type="button" class="button button-outline button-small" ?disabled=${td.options.length >= 8} @click=${() => { addMcqMultiOption(draft); this.requestUpdate(); }}>＋ Add option</button>
        </div>
        <div class="dynamic-item-list">
          ${td.options.map((opt, idx) => {
            const isChecked = td.correct_options.includes(opt.id);
            return html`<div class="dynamic-item-row ${isChecked ? 'is-correct-row' : ''}">
              <label class="correct-check-pill" title="Mark option ${opt.id} as a correct answer">
                <input type="checkbox" name="multi_correct_${opt.id}" aria-label="Mark option ${opt.id} as correct" .checked=${isChecked} @change=${(event) => { toggleMcqMultiCorrectOption(draft, opt.id, event.target.checked); this.requestUpdate(); }} />
                <span>${opt.id} · Correct</span>
              </label>
              <input name="multi_option_${idx}" aria-label="Option ${opt.id} text" required maxlength="500" .value=${opt.text} @input=${(event) => { opt.text = event.target.value; this.requestUpdate(); }} placeholder="Enter option ${opt.id}" />
              <button type="button" class="icon-remove-btn" aria-label="Remove option ${opt.id}" title="Remove option ${opt.id}" ?disabled=${td.options.length <= 2} @click=${() => { removeMcqMultiOption(draft, idx); this.requestUpdate(); }}>×</button>
            </div>`;
          })}
        </div>
        <div class="type-subgrid two-col">
          <label>Minimum selections <span class="optional-label">OPTIONAL</span>
            <input name="min_selections" type="number" min="1" max=${td.options.length} .value=${String(td.min_selections ?? '')} @input=${(event) => { td.min_selections = event.target.value; this.requestUpdate(); }} placeholder="e.g. 1" />
          </label>
          <label>Maximum selections <span class="optional-label">OPTIONAL</span>
            <input name="max_selections" type="number" min="1" max=${td.options.length} .value=${String(td.max_selections ?? '')} @input=${(event) => { td.max_selections = event.target.value; this.requestUpdate(); }} placeholder=${`e.g. ${td.options.length}`} />
          </label>
        </div>
      </fieldset>`;
    }

    if (qType === QUESTION_TYPES.TRUE_FALSE) {
      const isTrue = Boolean(td.correct_answer);
      return html`<fieldset class="type-fieldset" data-type-section="true_false">
        <legend>True / False answer key</legend>
        <div class="tf-toggle-row" role="radiogroup" aria-label="Correct True or False answer">
          <label class="tf-choice-card ${isTrue ? 'selected' : ''}">
            <input type="radio" name="correct_answer" value="true" .checked=${isTrue} @change=${() => { td.correct_answer = true; this.requestUpdate(); }} />
            <span><b>True</b><small>Statement is correct</small></span>
          </label>
          <label class="tf-choice-card ${!isTrue ? 'selected' : ''}">
            <input type="radio" name="correct_answer" value="false" .checked=${!isTrue} @change=${() => { td.correct_answer = false; this.requestUpdate(); }} />
            <span><b>False</b><small>Statement is incorrect</small></span>
          </label>
        </div>
        <div class="type-subgrid two-col">
          <label>True option label
            <input name="true_text" maxlength="120" .value=${td.true_text || 'True'} @input=${(event) => { td.true_text = event.target.value; this.requestUpdate(); }} placeholder="True" />
          </label>
          <label>False option label
            <input name="false_text" maxlength="120" .value=${td.false_text || 'False'} @input=${(event) => { td.false_text = event.target.value; this.requestUpdate(); }} placeholder="False" />
          </label>
        </div>
      </fieldset>`;
    }

    if (qType === QUESTION_TYPES.FILL_BLANK) {
      return html`<fieldset class="type-fieldset" data-type-section="fill_blank">
        <legend>Fill in the blank(s) & accepted answer variants</legend>
        <div class="type-section-head">
          <small class="field-help">In the question prompt, use [blank] or [blank1], [blank2] where blanks should appear. List accepted answers for each blank.</small>
          <button type="button" class="button button-outline button-small" ?disabled=${td.blanks.length >= 10} @click=${() => { addFillBlank(draft); this.requestUpdate(); }}>＋ Add blank</button>
        </div>
        <div class="dynamic-item-list">
          ${td.blanks.map((blank, bIdx) => html`
            <div class="blank-editor-card">
              <div class="blank-card-header">
                <b>Blank #${bIdx + 1} (${blank.id})</b>
                <input name="blank_label_${bIdx}" aria-label="Blank ${blank.id} label" maxlength="80" .value=${blank.label || `Blank ${bIdx + 1}`} @input=${(e) => { blank.label = e.target.value; this.requestUpdate(); }} placeholder="Label (e.g. Blank 1)" />
                <button type="button" class="icon-remove-btn" aria-label="Remove blank ${blank.id}" title="Remove blank" ?disabled=${td.blanks.length <= 1} @click=${() => { removeFillBlank(draft, bIdx); this.requestUpdate(); }}>×</button>
              </div>
              <div class="blank-variants-list">
                <small class="field-help">Accepted variants for this blank (exact match):</small>
                ${blank.variants.map((variant, vIdx) => html`
                  <div class="dynamic-item-row">
                    <span class="item-badge">Variant ${vIdx + 1}</span>
                    <input name="blank_${bIdx}_variant_${vIdx}" aria-label="Variant ${vIdx + 1} for ${blank.id}" required maxlength="120" .value=${variant} @input=${(e) => { blank.variants[vIdx] = e.target.value; this.requestUpdate(); }} placeholder="e.g. H2O" />
                    <button type="button" class="icon-remove-btn" aria-label="Remove variant ${vIdx + 1}" title="Remove variant" ?disabled=${blank.variants.length <= 1} @click=${() => { removeBlankVariant(draft, bIdx, vIdx); this.requestUpdate(); }}>×</button>
                  </div>
                `)}
                <button type="button" class="button button-outline button-small" ?disabled=${blank.variants.length >= 10} @click=${() => { addBlankVariant(draft, bIdx); this.requestUpdate(); }}>＋ Add accepted variant</button>
              </div>
            </div>
          `)}
        </div>
        <div class="type-subgrid two-col">
          <label class="check-setting inline-check">
            <input name="case_sensitive" type="checkbox" .checked=${Boolean(td.case_sensitive)} @change=${(e) => { td.case_sensitive = e.target.checked; this.requestUpdate(); }} />
            <span><b>Case-sensitive matching</b><small>Require exact capitalization for all blanks</small></span>
          </label>
        </div>
      </fieldset>`;
    }

    if (qType === QUESTION_TYPES.SHORT_ANSWER) {
      return html`<fieldset class="type-fieldset" data-type-section="short_answer">
        <legend>Accepted short answers (deterministic match)</legend>
        <div class="type-section-head">
          <small class="field-help">Add one or more accepted text responses. Responses are graded deterministically (no AI/NLP).</small>
          <button type="button" class="button button-outline button-small" ?disabled=${td.accepted_answers.length >= 25} @click=${() => { addShortAnswerAccepted(draft); this.requestUpdate(); }}>＋ Add accepted answer</button>
        </div>
        <div class="dynamic-item-list">
          ${td.accepted_answers.map((ans, idx) => html`<div class="dynamic-item-row">
            <span class="item-badge">#${idx + 1}</span>
            <input name="accepted_answer_${idx}" aria-label="Accepted answer ${idx + 1}" required maxlength="500" .value=${ans} @input=${(event) => { td.accepted_answers[idx] = event.target.value; this.requestUpdate(); }} placeholder=${idx === 0 ? 'Primary accepted answer (e.g. Dhaka)' : 'Alternative accepted spelling or synonym'} />
            <button type="button" class="icon-remove-btn" aria-label="Remove accepted answer ${idx + 1}" title="Remove accepted answer" ?disabled=${td.accepted_answers.length <= 1} @click=${() => { removeShortAnswerAccepted(draft, idx); this.requestUpdate(); }}>×</button>
          </div>`)}
        </div>
        <div class="type-subgrid three-col">
          <label class="check-setting inline-check">
            <input name="case_sensitive" type="checkbox" .checked=${Boolean(td.case_sensitive)} @change=${(event) => { td.case_sensitive = event.target.checked; this.requestUpdate(); }} />
            <span><b>Case-sensitive</b><small>Require exact uppercase/lowercase match</small></span>
          </label>
          <label>Max length (chars)
            <input name="max_length" type="number" min="1" max="500" .value=${String(td.max_length ?? 200)} @input=${(event) => { td.max_length = Number(event.target.value || 200); this.requestUpdate(); }} />
          </label>
          <label>Input placeholder <span class="optional-label">OPTIONAL</span>
            <input name="placeholder" maxlength="120" .value=${td.placeholder || ''} @input=${(event) => { td.placeholder = event.target.value; this.requestUpdate(); }} placeholder="e.g. Enter chemical symbol" />
          </label>
        </div>
      </fieldset>`;
    }

    if (qType === QUESTION_TYPES.NUMERIC) {
      return html`<fieldset class="type-fieldset" data-type-section="numeric">
        <legend>Numeric answer key & tolerance</legend>
        <div class="type-subgrid three-col">
          <label>Exact numeric value
            <input name="numeric_value" type="number" step="any" required .value=${String(td.value ?? '')} @input=${(event) => { td.value = event.target.value; this.requestUpdate(); }} placeholder="e.g. 9.8" />
          </label>
          <label>Acceptable tolerance (±)
            <input name="numeric_tolerance" type="number" step="any" min="0" .value=${String(td.tolerance ?? '0')} @input=${(event) => { td.tolerance = event.target.value; this.requestUpdate(); }} placeholder="0" />
          </label>
          <label>Unit <span class="optional-label">OPTIONAL</span>
            <input name="numeric_unit" maxlength="40" .value=${td.unit || ''} @input=${(event) => { td.unit = event.target.value; this.requestUpdate(); }} placeholder="e.g. m/s², kg, %" />
          </label>
        </div>
        <div class="type-subgrid two-col">
          <label class="check-setting inline-check">
            <input name="allow_decimals" type="checkbox" .checked=${Boolean(td.allow_decimals)} @change=${(event) => { td.allow_decimals = event.target.checked; this.requestUpdate(); }} />
            <span><b>Allow decimal values</b><small>Uncheck if students must enter a whole integer</small></span>
          </label>
          <label>Input placeholder <span class="optional-label">OPTIONAL</span>
            <input name="placeholder" maxlength="120" .value=${td.placeholder || ''} @input=${(event) => { td.placeholder = event.target.value; this.requestUpdate(); }} placeholder="e.g. Round to 2 decimal places" />
          </label>
        </div>
      </fieldset>`;
    }

    if (qType === QUESTION_TYPES.MATCHING) {
      return html`<fieldset class="type-fieldset" data-type-section="matching">
        <legend>Matching prompts, choices & answer pairs</legend>
        <div class="matching-editor-columns">
          <div class="matching-column">
            <div class="type-section-head">
              <b>Prompts & correct matches (${td.prompts.length})</b>
              <button type="button" class="button button-outline button-small" ?disabled=${td.prompts.length >= 10} @click=${() => { addMatchingPrompt(draft); this.requestUpdate(); }}>＋ Add prompt</button>
            </div>
            <div class="dynamic-item-list">
              ${td.prompts.map((prompt, idx) => html`<div class="dynamic-item-row matching-prompt-row">
                <span class="item-badge">${prompt.id}</span>
                <input name="matching_prompt_${idx}" aria-label="Prompt ${prompt.id} text" required maxlength="300" .value=${prompt.text} @input=${(event) => { prompt.text = event.target.value; this.requestUpdate(); }} placeholder="Prompt ${prompt.id}" />
                <span class="pair-arrow" aria-hidden="true">→</span>
                <select name="matching_pair_${prompt.id}" aria-label="Correct choice for ${prompt.id}" .value=${td.pairs[prompt.id] || ''} @change=${(event) => { td.pairs[prompt.id] = event.target.value; this.requestUpdate(); }}>
                  ${td.choices.map((choice) => html`<option value=${choice.id} ?selected=${td.pairs[prompt.id] === choice.id}>${choice.id}${choice.text ? `: ${choice.text.slice(0, 28)}` : ''}</option>`)}
                </select>
                <button type="button" class="icon-remove-btn" aria-label="Remove prompt ${prompt.id}" title="Remove prompt" ?disabled=${td.prompts.length <= 2} @click=${() => { removeMatchingPrompt(draft, idx); this.requestUpdate(); }}>×</button>
              </div>`)}
            </div>
          </div>
          <div class="matching-column">
            <div class="type-section-head">
              <b>Available choices (${td.choices.length})</b>
              <button type="button" class="button button-outline button-small" ?disabled=${td.choices.length >= 12} @click=${() => { addMatchingChoice(draft); this.requestUpdate(); }}>＋ Add choice</button>
            </div>
            <div class="dynamic-item-list">
              ${td.choices.map((choice, idx) => html`<div class="dynamic-item-row">
                <span class="item-badge choice-badge">${choice.id}</span>
                <input name="matching_choice_${idx}" aria-label="Choice ${choice.id} text" required maxlength="300" .value=${choice.text} @input=${(event) => { choice.text = event.target.value; this.requestUpdate(); }} placeholder="Choice ${choice.id}" />
                <button type="button" class="icon-remove-btn" aria-label="Remove choice ${choice.id}" title="Remove choice" ?disabled=${td.choices.length <= Math.max(2, td.prompts.length)} @click=${() => { removeMatchingChoice(draft, idx); this.requestUpdate(); }}>×</button>
              </div>`)}
            </div>
          </div>
        </div>
      </fieldset>`;
    }

    if (qType === QUESTION_TYPES.ORDERING) {
      const orderedIds = td.correct_order?.length === td.items.length ? td.correct_order : td.items.map((i) => i.id);
      const byId = new Map(td.items.map((item) => [item.id, item]));
      const orderedItems = orderedIds.map((id) => byId.get(id)).filter(Boolean);
      return html`<fieldset class="type-fieldset" data-type-section="ordering">
        <legend>Ordering sequence (arrange in correct order)</legend>
        <div class="type-section-head">
          <small class="field-help">Enter 2 to 10 items and use ↑ / ↓ to arrange them in the exact correct sequence from first to last.</small>
          <button type="button" class="button button-outline button-small" ?disabled=${orderedItems.length >= 10} @click=${() => { addOrderingItem(draft); this.requestUpdate(); }}>＋ Add item</button>
        </div>
        <div class="dynamic-item-list">
          ${orderedItems.map((item, idx) => html`<div class="dynamic-item-row ordering-item-row">
            <span class="item-badge">${idx + 1}. (${item.id})</span>
            <input name="ordering_item_${idx}" aria-label="Sequence item ${idx + 1}" required maxlength="300" .value=${item.text} @input=${(event) => { item.text = event.target.value; this.requestUpdate(); }} placeholder="Step or item ${idx + 1}" />
            <div class="order-move-controls">
              <button type="button" class="icon-move-btn" aria-label="Move item ${idx + 1} up" title="Move up" ?disabled=${idx === 0} @click=${() => { moveOrderingItem(draft, idx, -1); this.requestUpdate(); }}>↑</button>
              <button type="button" class="icon-move-btn" aria-label="Move item ${idx + 1} down" title="Move down" ?disabled=${idx === orderedItems.length - 1} @click=${() => { moveOrderingItem(draft, idx, 1); this.requestUpdate(); }}>↓</button>
              <button type="button" class="icon-remove-btn" aria-label="Remove item ${idx + 1}" title="Remove item" ?disabled=${orderedItems.length <= 2} @click=${() => { removeOrderingItem(draft, idx); this.requestUpdate(); }}>×</button>
            </div>
          </div>`)}
        </div>
      </fieldset>`;
    }

    return '';
  }

  renderQuestionPreviewModal() {
    const model = buildQuestionPreviewModel(this.previewingQuestion);
    if (!model) return '';
    return html`<div class="question-preview-modal">
      <div class="editor-title">
        <div>
          <span class="eyebrow muted">QUESTION PREVIEW · ${model.typeShortLabel.toUpperCase()}</span>
          <h3 id="question-preview-title">Question #${model.id ? String(model.id).padStart(2, '0') : 'Draft'}</h3>
        </div>
        <button type="button" class="icon-close" aria-label="Close question preview" @click=${this.closeQuestionPreview}>×</button>
      </div>
      ${this.renderQuestionPreviewCard(model)}
      <div class="editor-actions">
        <button type="button" class="button button-outline" @click=${this.closeQuestionPreview}>Close</button>
        <button type="button" class="button button-primary" @click=${() => this.editFromPreview(this.previewingQuestion)}>✎ Edit question</button>
      </div>
    </div>`;
  }

  renderQuestionPreviewCard(model, { isLiveDraft = false, compact = false } = {}) {
    if (!model) return '';
    const qType = model.question_type || DEFAULT_QUESTION_TYPE;
    const d = model.details || {};

    return html`<article class="question-preview-card ${compact ? 'compact' : ''}" data-preview-type="${qType}">
      <div class="preview-meta-row">
        <span class="question-type-pill type-${qType}">${model.typeLabel}</span>
        ${model.category ? html`<span class="category-pill">${model.category}</span>` : html`<span class="category-pill muted-pill">Subject not set</span>`}
        ${model.difficulty ? html`<span class="difficulty-tag ${model.difficulty.toLowerCase()}">${model.difficulty}</span>` : ''}
        ${model.locked ? html`<span class="lock-tag">⌑ In exam</span>` : ''}
      </div>

      ${model.stimulus ? html`
        <div class="preview-stimulus-box">
          <span class="eyebrow">REFERENCE STIMULUS</span>
          ${model.stimulus.title ? html`<h5>${model.stimulus.title}</h5>` : ''}
          ${model.stimulus.text ? html`<p>${unsafeHTML(sanitizeRichText(model.stimulus.text))}</p>` : ''}
          ${model.stimulus.media?.url ? html`
            <figure class="question-media-box">
              ${model.stimulus.media.type === 'audio'
                ? html`<audio controls preload="metadata" src=${model.stimulus.media.url}></audio>`
                : html`<img src=${model.stimulus.media.url} alt=${model.stimulus.title || 'Stimulus media'} />`}
            </figure>
          ` : ''}
        </div>
      ` : ''}

      <h4 class="preview-question-title">${unsafeHTML(renderQuestionText(model.question_text || (isLiveDraft ? 'Question prompt will appear here…' : '—')))}</h4>

      ${model.media ? html`
        <figure class="question-media-box">
          ${model.media.type === 'audio'
            ? html`<audio controls preload="metadata" src=${model.media.url} aria-label=${model.media.caption || 'Question audio clip'}></audio>`
            : html`<img src=${model.media.url} alt=${model.media.alt || model.question_text || 'Question illustration'} loading="lazy" />`}
          ${model.media.caption ? html`<figcaption>${model.media.caption}</figcaption>` : ''}
        </figure>
      ` : ''}

      ${qType === QUESTION_TYPES.MCQ_SINGLE ? html`
        <div class="selection-option-grid preview-options-grid">
          ${(d.options || []).map((opt) => html`<span class=${opt.isCorrect ? 'selection-correct-option' : ''}>
            <strong>${opt.id}.</strong> ${unsafeHTML(sanitizeRichText(opt.text || '—'))}
            ${opt.isCorrect ? html` <b class="correct-answer-label">✓ Correct answer</b>` : ''}
          </span>`)}
        </div>
      ` : ''}

      ${qType === QUESTION_TYPES.MCQ_MULTI ? html`
        <div class="selection-option-grid preview-options-grid">
          ${(d.options || []).map((opt) => html`<span class=${opt.isCorrect ? 'selection-correct-option' : ''}>
            <strong>[${opt.isCorrect ? '✓' : ' '}] ${opt.id}.</strong> ${unsafeHTML(sanitizeRichText(opt.text || '—'))}
            ${opt.isCorrect ? html` <b class="correct-answer-label">✓ Correct</b>` : ''}
          </span>`)}
        </div>
        ${(d.min_selections || d.max_selections) ? html`<small class="preview-rule-note">Selection limits: ${d.min_selections ? `min ${d.min_selections}` : ''}${d.min_selections && d.max_selections ? ', ' : ''}${d.max_selections ? `max ${d.max_selections}` : ''}</small>` : ''}
      ` : ''}

      ${qType === QUESTION_TYPES.TRUE_FALSE ? html`
        <div class="selection-option-grid preview-options-grid">
          ${(d.options || []).map((opt) => html`<span class=${opt.isCorrect ? 'selection-correct-option' : ''}>
            <strong>${opt.text}</strong>
            ${opt.isCorrect ? html` <b class="correct-answer-label">✓ Correct answer</b>` : ''}
          </span>`)}
        </div>
      ` : ''}

      ${qType === QUESTION_TYPES.YES_NO ? html`
        <div class="selection-option-grid preview-options-grid">
          ${(d.options || []).map((opt) => html`<span class=${opt.isCorrect ? 'selection-correct-option' : ''}>
            <strong>${opt.text}</strong>
            ${opt.isCorrect ? html` <b class="correct-answer-label">✓ Correct answer</b>` : ''}
          </span>`)}
        </div>
      ` : ''}

      ${qType === QUESTION_TYPES.FILL_BLANK ? html`
        <div class="preview-structured-box">
          <div class="preview-blanks-list">
            ${(d.blanks || []).map((b) => html`<div class="preview-blank-item">
              <span><strong>${b.label || b.id}:</strong></span>
              <span class="accepted-variants">${(b.accepted || []).map((v) => html`<span class="accepted-chip">${v}</span>`)}</span>
            </div>`)}
          </div>
          <small class="preview-rule-note">${d.case_sensitive ? 'Case-sensitive match' : 'Case-insensitive match'} · All blanks must be correct for credit</small>
        </div>
      ` : ''}

      ${qType === QUESTION_TYPES.SHORT_ANSWER ? html`
        <div class="preview-structured-box">
          <div><b>Accepted answers:</b> ${(d.accepted_answers || []).length ? d.accepted_answers.map((ans) => html`<span class="accepted-chip">${ans}</span>`) : html`<em>None entered yet</em>`}</div>
          <small class="preview-rule-note">${d.case_sensitive ? 'Case-sensitive match' : 'Case-insensitive match'} · Max ${d.max_length || 200} characters</small>
        </div>
      ` : ''}

      ${qType === QUESTION_TYPES.NUMERIC ? html`
        <div class="preview-structured-box">
          <div><b>Correct numeric value:</b> <span class="accepted-chip">${d.value !== undefined && d.value !== null && !Number.isNaN(Number(d.value)) ? d.value : '—'}${d.unit ? ` ${d.unit}` : ''}</span> ${d.tolerance > 0 ? html`<span class="tolerance-chip">±${d.tolerance}</span>` : html`<small>(exact)</small>`}</div>
          <small class="preview-rule-note">${d.allow_decimals ? 'Decimals allowed' : 'Whole integers only'}</small>
        </div>
      ` : ''}

      ${qType === QUESTION_TYPES.MATCHING ? html`
        <div class="preview-structured-box">
          <div class="preview-pairs-list">
            ${(d.prompts || []).map((p) => html`<div class="preview-pair-item">
              <span><strong>${p.id}.</strong> ${p.text || '—'}</span>
              <span class="pair-arrow">→</span>
              <span class="selection-correct-option"><strong>${p.matchedChoiceId || '?'}.</strong> ${p.matchedChoiceText || '—'}</span>
            </div>`)}
          </div>
          ${(d.choices || []).length > (d.prompts || []).length ? html`<small class="preview-rule-note">Includes ${(d.choices || []).length - (d.prompts || []).length} extra distractor choice(s).</small>` : ''}
        </div>
      ` : ''}

      ${qType === QUESTION_TYPES.ORDERING ? html`
        <div class="preview-structured-box">
          <ol class="preview-order-list">
            ${(d.orderedItems || []).map((item) => html`<li><strong>${item.id}:</strong> ${item.text || '—'}</li>`)}
          </ol>
        </div>
      ` : ''}

      ${model.explanation ? html`<small class="selection-explanation">Explanation: ${model.explanation}</small>` : ''}
    </article>`;
  }

  renderQuestionInlineSummary(question) {
    const qType = question.question_type || DEFAULT_QUESTION_TYPE;
    if (qType === QUESTION_TYPES.MCQ_SINGLE) {
      return html`<span class="selection-option-grid">${letters.map((letter) => html`<span class=${letter === question.correct_option ? 'selection-correct-option' : ''}><strong>${letter}.</strong> ${question[optionKeys[letter]]}${letter === question.correct_option ? html` <b class="correct-answer-label">✓ Correct answer</b>` : ''}</span>`)}</span>`;
    }
    const model = buildQuestionPreviewModel(question);
    return html`<div class="selection-non-mcq-summary">
      <span class="selection-correct-option"><b>Key (${model.typeShortLabel}):</b> ${formatCorrectAnswerSummary(question)}</span>
    </div>`;
  }

  renderBulkImport() {
    return html`<form class="bulk-import-panel stack-form" @submit=${this.importPastedQuestions}>
      <div class="bulk-intro"><div><span class="eyebrow muted">BULK QUESTION UPLOAD</span><h3>Paste up to 300 questions</h3><p>Use the same numbered format for every question, with a blank line between questions.</p></div><span class="bulk-count">1–300</span></div>
      <label>Subject<input name="subject" required maxlength="80" list="subject-options" placeholder="e.g. Biology" /></label>
      <div class="paste-sample">
        <div class="paste-sample-header">
          <b>Format sample (examples for each question type)</b>
          <div class="paste-sample-actions">
            <button type="button" class="button button-small button-outline" @click=${this.copyBulkSample}>Copy sample</button>
            <button type="button" class="button button-small button-outline" @click=${this.loadBulkSample}>Insert sample</button>
          </div>
        </div>
        <pre>${BULK_PASTE_SAMPLE}</pre>
        <small>Includes one example for every supported type: Single MCQ, Multi-select, True/False, Fill in blanks, Short answer, Numeric, Ordering, and Matching. Repeat with sequential numbering (1., 2., 3., etc.).</small>
      </div>
      <label>Questions<textarea name="text" required rows="12" spellcheck="false" placeholder="Paste your numbered questions here…"></textarea></label>
      <div class="editor-actions"><button type="button" class="button button-quiet" @click=${() => { this.bulkImportOpen = false; this.requestUpdate(); }}>Cancel</button><button class="button button-primary" ?disabled=${this.busy}>${this.busy ? 'Uploading…' : 'Upload questions'}</button></div>
    </form>`;
  }

  renderPasswordSettings() {
    return html`<div class="settings-grid">
      <section class="admin-panel portal-settings-panel">
        <div class="panel-heading">
          <div>
            <span class="eyebrow">CUSTOMIZATION</span>
            <h2>Portal branding & copy</h2>
            <p>Customize the site name, subtitle, hero slogans, and footer text.</p>
          </div>
          <span class="security-icon">✦</span>
        </div>
        <form class="stack-form settings-form" @submit=${this.saveSettings}>
          <div class="field-row">
            <label>Application / Site title
              <input name="site_title" required maxlength="80" .value=${this.settings.site_title || ''} placeholder="e.g. Northstar" />
            </label>
            <label>Brand subtitle (badge)
              <input name="site_subtitle" required maxlength="80" .value=${this.settings.site_subtitle || ''} placeholder="e.g. EXAMINATION PORTAL" />
            </label>
          </div>
          <div class="field-row">
            <label>Hero eyebrow slogan
              <input name="hero_eyebrow" required maxlength="120" .value=${this.settings.hero_eyebrow || ''} placeholder="e.g. LEARN · PREPARE · ACHIEVE" />
            </label>
            <label>Hero headline
              <input name="hero_title" required maxlength="160" .value=${this.settings.hero_title || ''} placeholder="e.g. Your next step starts here." />
            </label>
          </div>
          <label>Hero description
            <textarea name="hero_description" rows="2" maxlength="500" placeholder="Brief welcome message for candidates">${this.settings.hero_description || ''}</textarea>
          </label>
          <div class="field-row">
            <label>Hero tagline (bottom badge)
              <input name="hero_tagline" maxlength="120" .value=${this.settings.hero_tagline || ''} placeholder="e.g. A calm space to do your best work" />
            </label>
            <label>Footer copyright text
              <input name="footer_copyright" maxlength="120" .value=${this.settings.footer_copyright || ''} placeholder="e.g. Northstar Examination Portal" />
            </label>
          </div>
          <label>Footer tagline
            <input name="footer_tagline" maxlength="120" .value=${this.settings.footer_tagline || ''} placeholder="e.g. Thoughtful assessment, made simple ✦" />
          </label>
          <div class="field-row">
            <label class="check-setting" style="align-self: flex-start; margin-top: 6px;">
              <input name="enable_short_urls" type="checkbox" .checked=${this.isShortenerEnabled} value="1" />
              <span>
                <b>Enable is.gd URL shortener</b>
                <small>Keep disabled while using an IP address. Activate once you have a public domain name (is.gd rejects direct IP addresses).</small>
              </span>
            </label>
            <label>Public domain name
              <input name="public_url" maxlength="255" .value=${this.settings.public_url || ''} placeholder="e.g. https://exams.example.com" />
              <small class="field-help">Optional domain URL used when shortening links.</small>
            </label>
          </div>
          <div class="field-row">
            <label class="check-setting" style="align-self: flex-start; margin-top: 6px;">
              <input name="enable_animations" type="checkbox" .checked=${this.isAnimationsEnabled} value="1" />
              <span>
                <b>Enable UI animations & visual effects</b>
                <small>Global toggle for 3D card motions, dialog animations, and liquid glass blur across all devices.</small>
              </span>
            </label>
            <label class="check-setting" style="align-self: flex-start; margin-top: 6px;">
              <input name="auto_device_animations" type="checkbox" .checked=${this.isAutoDeviceAnimationsEnabled} value="1" />
              <span>
                <b>Auto-detect device (Mobile & low-end optimization)</b>
                <small>Automatically disables animations and heavy glass blur on smartphones, tablets, or low-spec hardware while keeping full motion on desktop.</small>
              </span>
            </label>
          </div>
          ${this.settingsError ? html`<div class="inline-error">${this.settingsError}</div>` : ''}
          <button class="button button-primary" ?disabled=${this.settingsBusy}>
            ${this.settingsBusy ? 'Saving settings…' : 'Save portal settings'}
          </button>
        </form>
      </section>
      <section class="admin-panel password-panel"><div class="panel-heading"><div><h2>Change admin password</h2><p>Choose a new password for your administrator account.</p></div><span class="security-icon">⌑</span></div>
        <form class="stack-form password-form" @submit=${this.changePassword}>
          <label>Current password<input name="current_password" type="password" autocomplete="current-password" required placeholder="Enter your current password" /></label>
          <label>New password<input name="new_password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required placeholder="At least 12 characters" /><small class="field-help">Use 12–128 characters.</small></label>
          <label>Confirm new password<input name="confirm_password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required placeholder="Enter the new password again" /></label>
          ${this.passwordError ? html`<div class="inline-error">${this.passwordError}</div>` : ''}
          <button class="button button-primary" ?disabled=${this.passwordBusy}>${this.passwordBusy ? 'Changing password…' : 'Change password'}</button>
        </form>
      </section>
      <section class="admin-panel backup-panel"><div class="panel-heading"><div><span class="eyebrow">YOUR DATA</span><h2>Database backup</h2></div><span class="security-icon" aria-hidden="true">↓</span></div><p>Keep a copy of your question bank, examinations, and participant records in one download.</p><a class="button button-primary" href="/api/admin/backup" download>↓ Download backup</a><small class="field-help">Includes private participant data and admin credentials. Store the file securely.</small></section>
    </div>`;
  }

  renderExamsAdmin() {
    const selectedQuestions = this.selectionIds.map((id) => this.questions.find((question) => question.id === id)).filter(Boolean);
    const selectedCategories = [...new Set(selectedQuestions.map((q) => q.category).filter(Boolean))];
    const availableForSubject = this.examSubject
      ? this.questions.filter((question) => question.category === this.examSubject)
      : this.questions;
    return html`<section class="exam-admin-layout">
      <div class="admin-panel exam-create-panel"><div class="panel-heading"><div><h2>Create an examination</h2><p>Choose a fixed question set and set your result rules.</p></div><span class="create-spark">✦</span></div>
        <form class="stack-form create-exam-form" @submit=${this.createExam}>
          <div class="field-row"><label>Examination title<input name="title" required maxlength="160" placeholder="e.g. General Knowledge — October" /></label><label>Duration (minutes)<input name="duration_minutes" type="number" min="1" max="1440" value="30" required /></label></div>
          <label>Exam subject <span class="optional-label">OPTIONAL · DEFAULTS TO SELECTED SUBJECTS</span><input name="subject" list="exam-subject-options" maxlength="80" placeholder="e.g. Combined Science (or leave blank to auto-detect)" /><datalist id="exam-subject-options">${this.questionCategories.map((value) => html`<option value=${value}></option>`)}</datalist></label>
          <label>Description <span class="optional-label">OPTIONAL</span><textarea name="description" rows="2" maxlength="500" placeholder="Give students a little context"></textarea></label>
          <fieldset class="selection-fieldset"><legend>Question selection</legend>
            <label class="subject-select-label">Filter questions by subject<select .value=${this.examSubject} @change=${(event) => { this.examSubject = event.target.value; this.selectionSearch = ''; this.randomCount = 10; this.requestUpdate(); }}><option value="">All subjects (${this.questions.length})</option>${this.questionCategories.map((value) => html`<option value=${value}>${value} (${this.questions.filter((q) => q.category === value).length})</option>`)}</select></label>
            <div class="selection-switch"><button type="button" class=${this.selectionMode === 'manual' ? 'selected' : ''} @click=${() => { this.selectionMode = 'manual'; this.requestUpdate(); }}>☷ &nbsp; Manual selection</button><button type="button" class=${this.selectionMode === 'random' ? 'selected' : ''} @click=${() => { this.selectionMode = 'random'; this.requestUpdate(); }}>⤨ &nbsp; Random selection</button></div>
            ${this.selectionMode === 'manual' ? html`<div class="selection-tools"><span>${this.examSubject ? `${availableForSubject.length} questions in ${this.examSubject}` : `${this.questions.length} questions across all subjects`}</span><label class="compact-search"><span>⌕</span><input placeholder="Find a question…" .value=${this.selectionSearch} @input=${(event) => { this.selectionSearch = event.target.value; this.requestUpdate(); }} /></label></div><div class="selection-list">${this.selectionQuestions.map((question) => html`<label class="selection-item"><input type="checkbox" .checked=${this.selectionIds.includes(question.id)} @change=${(event) => this.toggleSelectedQuestion(question.id, event.target.checked)} /><span class="selection-item-content"><div class="selection-item-head"><span class="category-pill">${question.category}</span><span class="question-type-pill type-${question.question_type || 'mcq_single'}">${formatQuestionTypeBadge(question).shortLabel}</span><b>${unsafeHTML(renderQuestionText(question.question_text))}</b></div>${this.renderQuestionInlineSummary(question)}${question.explanation ? html`<small class="selection-explanation">Explanation: ${question.explanation}</small>` : ''}<small>${question.difficulty || 'Difficulty not set'}</small></span></label>`)}</div>` : html`<div class="random-maker"><label>Number of questions<input type="number" min="1" max=${Math.max(1, availableForSubject.length)} .value=${String(this.randomCount)} ?disabled=${!availableForSubject.length} @input=${(event) => { this.randomCount = event.target.value; this.requestUpdate(); }} /></label><button type="button" class="button button-outline" ?disabled=${!availableForSubject.length} @click=${this.regenerateRandom}>⟳ Regenerate selection</button><div class="random-preview"><span class="preview-icon">✧</span><div><b>${this.selectionIds.length ? `${this.selectionIds.length} questions selected` : 'Preview your random selection'}</b><small>${availableForSubject.length ? `Random picks use ${this.examSubject ? `${this.examSubject} questions.` : 'all available questions.'}` : 'No questions found.'}</small></div></div></div>`}
          <div class="selection-footer"><span><b>${this.selectionIds.length}</b> question${this.selectionIds.length === 1 ? '' : 's'} selected${selectedCategories.length > 1 ? ` across ${selectedCategories.length} subjects` : selectedCategories.length === 1 ? ` (${selectedCategories[0]})` : ''}</span><span>1 mark each · −${Number(this.querySelector?.('[name="negative_mark"]')?.value || 1)} for a wrong answer</span></div>
            ${selectedQuestions.length ? html`<div class="selected-questions-preview" aria-label="Full selected question preview">${selectedQuestions.map((q, index) => html`<article class="selected-question-preview"><div class="selected-preview-heading"><span>${String(index + 1).padStart(2, '0')}</span><span class="category-pill">${q.category}</span><span class="question-type-pill type-${q.question_type || 'mcq_single'}">${formatQuestionTypeBadge(q).shortLabel}</span><b>${unsafeHTML(renderQuestionText(q.question_text))}</b><button type="button" class="remove-selection-btn" title="Remove question" aria-label="Remove question ${index + 1}" @click=${() => this.toggleSelectedQuestion(q.id, false)}>×</button></div>${this.renderQuestionInlineSummary(q)}${q.explanation ? html`<small class="selection-explanation">Explanation: ${q.explanation}</small>` : ''}</article>`)}</div>` : ''}
          </fieldset>
          <div class="field-row"><label>Wrong answer penalty<select name="negative_mark" required><option value="0">0 marks (No penalty)</option><option value="1">−1 mark</option><option value="0.25">−0.25 mark</option><option value="0.5">−0.50 mark</option></select><small class="field-help">Unanswered questions receive no penalty.</small></label><label>Initial status<select name="status"><option value="published">Published</option><option value="draft">Draft</option></select></label></div>
          <div class="settings-row"><div class="result-settings"><span class="setting-title">Student results</span><label class="check-setting"><input name="show_score" type="checkbox" @change=${(event) => { const answerBox = this.querySelector?.('[name="show_answers"]'); if (answerBox) { answerBox.disabled = !event.target.checked; if (!event.target.checked) answerBox.checked = false; } }} /><span><b>Show final score</b><small>Students can see their total mark.</small></span></label><label class="check-setting"><input name="show_answers" type="checkbox" disabled /><span><b>Show answer review</b><small>Students can review correct answers and explanations.</small></span></label><label class="check-setting"><input name="allow_pdf_download" type="checkbox" /><span><b>Allow PDF download</b><small>Students can download their result report and answer sheet with explanations as PDF.</small></span></label></div></div>
          <button class="button button-primary button-full" ?disabled=${this.busy}>${this.busy ? 'Creating examination…' : 'Create examination'} <span aria-hidden="true">→</span></button>
        </form>
      </div>
      <div class="admin-panel exam-list-panel"><div class="panel-heading"><div><h2>Your examinations</h2><p>Review status and participant results.</p></div><span class="exam-total">${this.exams.length}</span></div>
        ${this.exams.length ? html`<div class="admin-exam-list">${this.exams.map((exam) => html`<article class="admin-exam-card"><div class="admin-exam-title"><div class="exam-list-icon">▣</div><div><h3>${exam.title}</h3><p>${exam.subject || 'No subject'} · ${exam.question_count} questions · ${exam.duration_minutes} min · −${Number(exam.negative_mark || 0)} wrong · ${exam.participant_count} participant${exam.participant_count === 1 ? '' : 's'}</p></div><span class="status-tag ${exam.status}">${exam.status}</span></div><div class="exam-list-actions"><label class="status-control">Status <select .value=${exam.status} @change=${(event) => this.changeExamStatus(exam, event.target.value)}><option value="draft">Draft</option><option value="published">Published</option><option value="closed">Closed</option></select></label><button class="button button-outline button-small" ?disabled=${exam.status !== 'published'} @click=${() => this.copyExamLink(exam)}>${this.shorteningExamId === exam.id ? 'Shortening…' : 'Copy link'}</button><a class="button button-quiet button-small" href=${exam.status === 'published' ? ((this.isShortenerEnabled && exam.short_url) || this.examUrl(exam)) : undefined} ?hidden=${exam.status !== 'published'} target="_blank" rel="noopener">Open ↗</a><button class="button button-outline button-small" @click=${() => this.loadAttempts(exam)}>View results <span>→</span></button><button class="button button-danger button-small" @click=${() => this.deleteExam(exam)}>Delete exam</button></div>
            ${exam.status === 'published' ? (this.isShortenerEnabled ? html`<div class="exam-share-row"><div class="exam-share-link-group"><span class="share-tag ${exam.short_url ? 'isgd' : 'direct'}">${exam.short_url ? 'is.gd short link' : 'Exam link'}</span><a href=${exam.short_url || this.examUrl(exam)} target="_blank" rel="noopener" class="exam-share-anchor">${exam.short_url || this.examUrl(exam)}</a></div><div class="exam-share-actions"><button type="button" class="button button-quiet button-small" @click=${() => this.promptCustomizeShortUrl(exam)} title="Customize or regenerate is.gd short URL">${exam.short_url ? 'Customize ✎' : 'Shorten ✂'}</button></div></div>` : html`<div class="exam-share-row"><span>Public exam link</span><a href=${this.examUrl(exam)} target="_blank" rel="noopener">${this.examUrl(exam)}</a></div>`) : html`<div class="exam-share-row unavailable-share"><span>Public link available after publishing</span></div>`}
            <div class="exam-visibility"><span>Student results</span><label title="Show final score to students"><input type="checkbox" .checked=${Boolean(exam.show_score)} @change=${(event) => this.changeExamVisibility(exam, 'score', event.target.checked)} /> Show score</label><label title="Show individual answer review to students"><input type="checkbox" .checked=${Boolean(exam.show_answers)} ?disabled=${!exam.show_score} @change=${(event) => this.changeExamVisibility(exam, 'answers', event.target.checked)} /> Show answers</label><label title="Allow students to download result as PDF"><input type="checkbox" .checked=${Boolean(exam.allow_pdf_download)} @change=${(event) => this.changeExamVisibility(exam, 'pdf', event.target.checked)} /> PDF download</label></div>
            ${this.resultExam?.id === exam.id ? this.renderAttempts(exam) : ''}</article>`)}</div>` : html`<div class="empty-state"><div class="empty-illustration">▣</div><h3>No examinations yet</h3><p>Build one from the question bank to get started.</p></div>`}
      </div>
    </section>`;
  }

  renderAttempts(exam) {
    if (this.answerSheet && this.resultExam?.id === exam.id) return this.renderAnswerSheet();
    const results = filterAndSortResults(this.attempts, this.resultSearch, this.resultSort);
    return html`<div class="attempts-panel">
      <div class="attempts-heading">
        <b>Participants</b>
        <div class="attempts-header-actions">
          <span>${this.attempts.length} attempt${this.attempts.length === 1 ? '' : 's'}</span>
          ${this.attempts.length ? html`<button class="button button-outline button-small" @click=${() => this.exportAttemptsCsv(exam)}>↓ Export CSV</button>` : ''}
        </div>
      </div>
      ${this.attempts.length ? html`<div class="result-list-controls">
        <label>Search results<input type="search" placeholder="Search by name or roll number…" .value=${this.resultSearch} @input=${event => { this.resultSearch = event.target.value; this.requestUpdate(); }} /></label>
        <label>Sort results<select .value=${this.resultSort} @change=${event => { this.resultSort = event.target.value; this.requestUpdate(); }}>
          <option value="recent">Most recent first</option>
          <option value="roll-asc">Roll number: ascending</option>
          <option value="roll-desc">Roll number: descending</option>
          <option value="score-asc">Score: lowest first</option>
          <option value="score-desc">Score: highest first</option>
        </select></label>
        <span class="result-match-count" role="status">${results.length} of ${this.attempts.length} results</span>
      </div>` : ''}
      ${results.length ? html`<div class="attempt-list">${results.map((attempt) => html`<div class="attempt-list-item"><button class="attempt-row" @click=${() => this.openAnswerSheet(attempt)}><span class="attempt-avatar">${attempt.student_name.slice(0, 1).toUpperCase()}</span><span class="attempt-person"><b>${attempt.student_name}</b><small>Roll ${attempt.roll_number}${attempt.email ? ` · ${attempt.email}` : ''}</small></span><span class="attempt-score">${attempt.score === null ? '—' : `${attempt.score} / ${exam.question_count}`}</span><span class="status-tag ${attempt.status}">${attempt.status.replace('_', ' ')}</span><span class="row-arrow">→</span></button><button class="button button-danger button-small" aria-label=${`Delete result sheet for ${attempt.student_name}, roll ${attempt.roll_number}`} @click=${() => this.deleteAttempt(attempt)}>Delete result sheet</button></div>`)}</div>` : html`<div class="empty-inline">${this.attempts.length ? "No results match your search. Try another name or roll number." : "No participants yet. Share the published exam link with students."}</div>`}
    </div>`;
  }

  renderAnswerSheet() {
    const sheet = this.answerSheet;
    const graded = sheet.status !== 'in_progress';
    return html`<div class="answer-sheet"><div class="sheet-header"><div><button class="back-link compact-back" @click=${() => { this.answerSheet = null; this.requestUpdate(); }}>← Participants</button><h3>${sheet.student_name}<span> · Roll ${sheet.roll_number}</span></h3><p>${sheet.exam_title} · ${sheet.email || 'No email provided'} · ${sheet.address || 'No address provided'}</p></div><div class="sheet-score"><b>${sheet.score}</b><small>FINAL SCORE</small></div></div><div class="sheet-controls"><button class="button button-outline button-small" @click=${() => this.downloadResultPdf(sheet)}>↓ Download PDF</button><button class="button button-danger button-small" @click=${() => this.deleteAttempt(sheet)}>Delete result sheet</button></div><div class="sheet-meta"><span class="status-tag ${sheet.status}">${sheet.status.replace('_', ' ')}</span><span>Exam penalty: −${Number(this.resultExam?.negative_mark || 0)} where applicable</span><span>Started ${this.formatDate(sheet.started_at)}</span><span>${sheet.submitted_at ? `Submitted ${this.formatDate(sheet.submitted_at)}` : 'Not submitted'}</span></div>
      <div class="sheet-questions">${sheet.answers.map((answer, index) => {
        const qType = answer.question_type || DEFAULT_QUESTION_TYPE;
        const answered = isAnswerProvided(answer, answer.selected_option, answer.answer_data);
        const partial = graded && !answer.is_correct && answered && Number(answer.marks_awarded) > 0;
        return html`<article class="sheet-question ${graded ? answer.is_correct ? 'is-correct' : partial ? 'is-partial' : answered ? 'is-wrong' : 'is-pending' : 'is-pending'}"><div class="sheet-q-head"><span>QUESTION ${String(index + 1).padStart(2, '0')} · ${formatQuestionTypeBadge(answer).shortLabel.toUpperCase()}</span><span class=${graded ? answer.is_correct ? 'correct-text' : partial ? 'partial-text' : answered ? 'wrong-text' : 'pending-text' : 'pending-text'}>${graded ? answer.is_correct ? '✓ Correct' : partial ? 'Partial credit' : answered ? '× Incorrect' : 'Not answered' : 'Not graded'}</span></div><h4>${unsafeHTML(renderQuestionText(answer.question_text))}</h4>
          ${qType === QUESTION_TYPES.MCQ_SINGLE
            ? html`<div class="sheet-answers">${letters.map((letter) => html`<div class="sheet-option ${letter === answer.correct_option ? 'right-option' : ''} ${graded && letter === answer.selected_option && !answer.is_correct ? 'chosen-wrong' : ''}"><span>${letter}</span><span>${answer[optionKeys[letter]]}</span>${letter === answer.selected_option ? html`<small class="student-label">STUDENT</small>` : ''}${letter === answer.correct_option ? html`<small>CORRECT</small>` : ''}</div>`)}</div>`
            : html`<div class="sheet-non-mcq-review"><p><b>Student response:</b> ${formatStudentAnswerSummary(answer)}</p><p><b>Correct answer:</b> ${formatCorrectAnswerSummary(answer)}</p></div>`}
          ${answer.explanation ? html`<p class="answer-explanation"><b>Explanation</b> ${answer.explanation}</p>` : ''}
          <div class="marks-row"><span>Student selected <b>${qType === QUESTION_TYPES.MCQ_SINGLE ? (answer.selected_option ? `Option ${answer.selected_option}` : 'No answer') : (answered ? formatStudentAnswerSummary(answer) : 'No answer')}</b></span><span>${graded ? `${answer.marks_awarded ?? 0} / ${answer.marks} mark${answer.marks === 1 ? '' : 's'}` : 'Pending submission'}</span></div></article>`;
      })}</div>
      <button class="button button-outline button-full back-sheet-button" @click=${() => { this.answerSheet = null; this.requestUpdate(); }}>← Back to participants</button>
    </div>`;
  }

  formatDate(value) {
    if (!value) return '—';
    const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  renderStartDialog() {
    return html`<div class="modal-backdrop" @click=${(event) => { if (event.target === event.currentTarget) this.dismissStart(); }}><section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="start-title"><button class="icon-close modal-close" @click=${this.dismissStart}>×</button><span class="eyebrow muted">BEFORE YOU BEGIN</span><h2 id="start-title">${this.startingExam.title}</h2><p class="modal-intro">${this.startingExam.question_count} questions · ${this.startingExam.duration_minutes} minutes. Enter your details to begin.</p><div class="start-reminder"><span>◷</span><span>${this.startingExam.loadingDetails ? 'Loading the exam scoring rule…' : `Your timer starts as soon as you begin. Wrong answers lose ${Number(this.startingExam.negative_mark || 0)} mark where applicable; Yes/No and multi-select questions use their own scoring rules. Unanswered questions receive no penalty.`}</span></div><form class="stack-form" @submit=${this.startExam}><label>Full name<input name="student_name" required maxlength="120" autocomplete="name" placeholder="Your name" /></label><label>Email<input name="email" type="email" required maxlength="254" autocomplete="email" placeholder="you@example.com" /></label><label>Address<input name="address" required maxlength="500" autocomplete="street-address" placeholder="Your address" /></label><label>Roll number<input name="roll_number" required maxlength="60" placeholder="Your roll number" /></label><button class="button button-primary button-full" ?disabled=${this.busy || this.startingExam.loadingDetails}>${this.startingExam.loadingDetails ? 'Loading exam…' : this.busy ? 'Preparing your exam…' : 'Begin examination'} <span>→</span></button></form><button class="text-button modal-cancel" @click=${this.dismissStart}>Maybe later</button></section></div>`;
  }

  renderSubmitConfirmDialog() {
    const total = this.attempt?.questions?.length || 0;
    const answered = Object.values(this.answers).filter(Boolean).length;
    const unanswered = Math.max(0, total - answered);
    return html`<div class="modal-backdrop" @click=${(event) => { if (event.target === event.currentTarget) { this.closeSubmitConfirm(); } }}>
      <section class="modal-card confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-submit-title">
        <button class="icon-close modal-close" @click=${() => { this.closeSubmitConfirm(); }}>×</button>
        <span class="eyebrow muted">SUBMISSION CONFIRMATION</span>
        <h2 id="confirm-submit-title">Submit your examination?</h2>
        <p class="modal-intro">Review your answer progress before final scoring.</p>
        <div class="confirm-summary-cards">
          <div class="confirm-stat-card answered">
            <span class="stat-badge">✓</span>
            <div>
              <strong>${answered} / ${total}</strong>
              <small>Questions answered</small>
            </div>
          </div>
          <div class="confirm-stat-card ${unanswered > 0 ? 'unanswered-warning' : 'unanswered-zero'}">
            <span class="stat-badge">${unanswered > 0 ? '!' : '✓'}</span>
            <div>
              <strong>${unanswered}</strong>
              <small>${unanswered === 1 ? 'Unanswered question' : 'Unanswered questions'}</small>
            </div>
          </div>
        </div>
        <div class="confirm-notice">
          ${unanswered > 0 ? html`<span>⚠️</span><span>You still have <b>${unanswered} unanswered question${unanswered === 1 ? '' : 's'}</b>. Once submitted, answers cannot be modified.</span>` : html`<span>✦</span><span>You have answered all questions. Once submitted, your score will be calculated.</span>`}
        </div>
        <div class="confirm-actions">
          <button type="button" class="button button-outline" @click=${() => { this.closeSubmitConfirm(); }}>
            ← Keep reviewing
          </button>
          <button type="button" class="button button-primary" ?disabled=${this.busy} @click=${() => this.executeSubmitAttempt(false)}>
            ${this.busy ? 'Submitting…' : 'Submit examination now →'}
          </button>
        </div>
      </section>
    </div>`;
  }

  renderStudentQuestionInput(question) {
    const qType = question.question_type || DEFAULT_QUESTION_TYPE;
    const qConfig = question.question_config || {};
    const currentData = this.answerDataByQuestion[question.id] || {};

    if (qType === QUESTION_TYPES.MCQ_SINGLE) {
      return html`
        <p class="question-hint">Select one answer to continue</p>
        <div class="answer-options">
          ${letters.map((letter) => html`<label class="answer-option ${this.answers[question.id] === letter ? 'selected' : ''}">
            <input type="radio" name=${`answer_${question.id}`} value=${letter} aria-label=${`Option ${letter}`} style="width:auto;min-height:auto;padding:0;border:0;box-shadow:none" .checked=${this.answers[question.id] === letter} @change=${() => this.selectAnswer(question, letter)} />
            <span class="option-text">${unsafeHTML(sanitizeRichText(question[optionKeys[letter]] || (qConfig.options || []).find((o) => o.id === letter)?.text || ''))}</span>
            <span class="option-radio">${this.answers[question.id] === letter ? html`<i></i>` : ''}</span>
          </label>`)}
        </div>
      `;
    }

    if (qType === QUESTION_TYPES.MCQ_MULTI) {
      const selectedList = Array.isArray(currentData.selected_options) ? currentData.selected_options : [];
      const selectedSet = new Set(selectedList);
      const options = Array.isArray(qConfig.options) ? qConfig.options : [];
      return html`
        <p class="question-hint">Select all options that apply${qConfig.max_selections ? ` (up to ${qConfig.max_selections})` : ''}</p>
        <div class="answer-options">
          ${options.map((opt) => {
            const isSelected = selectedSet.has(opt.id);
            const atMax = Number(qConfig.max_selections) > 0 && selectedList.length >= Number(qConfig.max_selections);
            return html`<label class="answer-option ${isSelected ? 'selected' : ''}">
              <input type="checkbox" name=${`answer_${question.id}`} value=${opt.id} aria-label=${`Option ${opt.id}: ${opt.text}`} .checked=${isSelected} ?disabled=${!isSelected && atMax} @change=${(event) => {
              const nextSet = new Set(selectedSet);
              if (event.target.checked) nextSet.add(opt.id);
              else nextSet.delete(opt.id);
              const nextOptions = options.map((o) => o.id).filter((id) => nextSet.has(id));
              this.saveStructuredAnswer(question, nextOptions.length ? { selected_options: nextOptions } : null);
            }}>
              <span class="option-letter">${opt.id}</span>
              <span class="option-text">${unsafeHTML(sanitizeRichText(opt.text))}</span>
              <span class="option-radio">${isSelected ? html`<i></i>` : ''}</span>
            </label>`;
          })}
        </div>
      `;
    }

    if (qType === QUESTION_TYPES.TRUE_FALSE) {
      const selectedAns = currentData.selected_answer;
      const options = Array.isArray(qConfig.options) && qConfig.options.length === 2
        ? qConfig.options
        : [{ id: 'true', text: 'True' }, { id: 'false', text: 'False' }];
      return html`
        <p class="question-hint">Select True or False</p>
        <div class="answer-options">
          ${options.map((opt) => {
            const boolVal = opt.id === 'true';
            const isSelected = selectedAns === boolVal;
            return html`<button type="button" class="answer-option ${isSelected ? 'selected' : ''}" aria-pressed=${String(isSelected)} @click=${() => {
              this.saveStructuredAnswer(question, { selected_answer: boolVal });
            }}>
              <span class="option-letter">${boolVal ? 'T' : 'F'}</span>
              <span class="option-text">${unsafeHTML(sanitizeRichText(opt.text))}</span>
              <span class="option-radio">${isSelected ? html`<i></i>` : ''}</span>
            </button>`;
          })}
        </div>
      `;
    }

    if (qType === QUESTION_TYPES.YES_NO || qType === 'yes_no') {
      const selectedAnswer = currentData.selected_answer;
      const options = [{ id: 'yes', text: 'Yes' }, { id: 'no', text: 'No' }];
      return html`
        <p class="question-hint">Select Yes or No</p>
        <div class="answer-options">
          ${options.map((option) => html`<label class="answer-option ${selectedAnswer === option.id ? 'selected' : ''}">
            <input type="radio" name=${`answer_${question.id}`} value=${option.id} aria-label=${option.text} style="width:auto;min-height:auto;padding:0;border:0;box-shadow:none" .checked=${selectedAnswer === option.id} @change=${() => this.saveStructuredAnswer(question, { selected_answer: option.id })} />
            <span class="option-text">${option.text}</span>
            <span class="option-radio">${selectedAnswer === option.id ? html`<i></i>` : ''}</span>
          </label>`)}
        </div>
      `;
    }

    if (qType === QUESTION_TYPES.FILL_BLANK) {
      const blanks = Array.isArray(qConfig.blanks) && qConfig.blanks.length > 0
        ? qConfig.blanks
        : [{ id: 'B1', label: 'Blank 1' }];
      const currentBlanks = currentData.blanks && typeof currentData.blanks === 'object' ? currentData.blanks : {};
      return html`
        <p class="question-hint">Fill in the blank(s) below${qConfig.case_sensitive ? ' (case-sensitive)' : ''}</p>
        <div class="student-blank-list">
          ${blanks.map((b, idx) => {
            const val = currentBlanks[b.id] ?? currentBlanks[b.id.toLowerCase()] ?? '';
            return html`<div class="student-blank-row">
              <span class="option-letter">${b.id}</span>
              <label class="student-blank-label">
                <span>${b.label || `Blank ${idx + 1}`}</span>
                <input type="text" class="student-blank-input" aria-label=${b.label || `Blank ${idx + 1}`} maxlength=${b.max_length || 100} placeholder="Type your answer…" .value=${val} @input=${(e) => {
                  const nextBlanks = { ...currentBlanks, [b.id]: e.target.value };
                  this.saveStructuredAnswer(question, { blanks: nextBlanks });
                }} />
              </label>
            </div>`;
          })}
        </div>
      `;
    }

    if (qType === QUESTION_TYPES.SHORT_ANSWER) {
      const currentText = typeof currentData.text === 'string' ? currentData.text : '';
      return html`
        <p class="question-hint">Type your short answer below${qConfig.case_sensitive ? ' (case-sensitive)' : ''}</p>
        <div class="student-text-answer">
          <input type="text" aria-label="Your short answer" maxlength=${qConfig.max_length || 200} placeholder=${qConfig.placeholder || 'Type your answer…'} .value=${currentText} @change=${(event) => {
            const trimmed = event.target.value.trim();
            this.saveStructuredAnswer(question, trimmed ? { text: trimmed } : null);
          }} />
        </div>
      `;
    }

    if (qType === QUESTION_TYPES.NUMERIC) {
      const currentVal = currentData.value !== undefined && currentData.value !== null ? String(currentData.value) : '';
      return html`
        <p class="question-hint">Enter a ${qConfig.allow_decimals === false ? 'whole number' : 'numeric value'}${qConfig.unit ? ` (${qConfig.unit})` : ''}</p>
        <div class="student-numeric-answer">
          <input type="number" step=${qConfig.allow_decimals === false ? '1' : 'any'} aria-label="Your numeric answer" placeholder=${qConfig.placeholder || 'Enter number…'} .value=${currentVal} @change=${(event) => {
            const raw = event.target.value.trim();
            this.saveStructuredAnswer(question, raw !== '' && Number.isFinite(Number(raw)) ? { value: Number(raw) } : null);
          }} />
          ${qConfig.unit ? html`<span class="unit-badge">${qConfig.unit}</span>` : ''}
        </div>
      `;
    }

    if (qType === QUESTION_TYPES.MATCHING) {
      const prompts = Array.isArray(qConfig.prompts) ? qConfig.prompts : [];
      const choices = Array.isArray(qConfig.choices) ? qConfig.choices : [];
      const currentPairs = currentData.pairs && typeof currentData.pairs === 'object' ? currentData.pairs : {};
      return html`
        <p class="question-hint">Match each prompt with the corresponding choice</p>
        <div class="student-matching-list">
          ${prompts.map((p) => html`<div class="student-matching-row">
            <span class="prompt-label"><strong>${p.id}.</strong> ${unsafeHTML(sanitizeRichText(p.text))}</span>
            <select aria-label="Match for ${p.text}" .value=${currentPairs[p.id] || ''} @change=${(event) => {
              const nextPairs = { ...currentPairs, [p.id]: event.target.value };
              this.saveStructuredAnswer(question, { pairs: nextPairs });
            }}>
              <option value="">Choose match…</option>
              ${choices.map((c) => html`<option value=${c.id} ?selected=${currentPairs[p.id] === c.id}>${c.id}. ${c.text}</option>`)}
            </select>
          </div>`)}
        </div>
      `;
    }

    if (qType === QUESTION_TYPES.ORDERING) {
      const items = Array.isArray(qConfig.items) ? qConfig.items : [];
      const itemMap = new Map(items.map((i) => [i.id, i]));
      if (!this.orderingInitialState) this.orderingInitialState = {};
      if (!this.orderingInitialState[question.id]) {
        const rawIds = items.map((i) => i.id);
        this.orderingInitialState[question.id] = rawIds.length >= 2 ? [...rawIds].reverse() : rawIds;
      }
      const currentOrder = Array.isArray(currentData.order) && currentData.order.length === items.length
        ? currentData.order
        : this.orderingInitialState[question.id];

      return html`
        <p class="question-hint">Drag and drop or use the arrows to arrange the items into the correct order</p>
        <div class="student-ordering-list" role="list">
          ${currentOrder.map((id, idx) => {
            const item = itemMap.get(id) || { id, text: '' };
            return html`<div class="student-ordering-row"
              role="listitem"
              draggable="true"
              @dragstart=${(e) => {
                e.dataTransfer.setData('text/plain', String(idx));
                e.dataTransfer.effectAllowed = 'move';
              }}
              @dragover=${(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }}
              @drop=${(e) => {
                e.preventDefault();
                const fromIdx = Number(e.dataTransfer.getData('text/plain'));
                if (Number.isInteger(fromIdx) && fromIdx !== idx && fromIdx >= 0 && fromIdx < currentOrder.length) {
                  const nextOrder = [...currentOrder];
                  const [moved] = nextOrder.splice(fromIdx, 1);
                  nextOrder.splice(idx, 0, moved);
                  this.saveStructuredAnswer(question, { order: nextOrder });
                }
              }}>
              <span class="drag-handle" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
              <span class="option-letter">${idx + 1}</span>
              <span class="option-text">${unsafeHTML(sanitizeRichText(item.text))}</span>
              <div class="order-move-controls">
                <button type="button" class="icon-move-btn" aria-label="Move ${item.text} up" ?disabled=${idx === 0} @click=${() => {
                  const nextOrder = [...currentOrder];
                  [nextOrder[idx - 1], nextOrder[idx]] = [nextOrder[idx], nextOrder[idx - 1]];
                  this.saveStructuredAnswer(question, { order: nextOrder });
                }}>↑</button>
                <button type="button" class="icon-move-btn" aria-label="Move ${item.text} down" ?disabled=${idx === currentOrder.length - 1} @click=${() => {
                  const nextOrder = [...currentOrder];
                  [nextOrder[idx + 1], nextOrder[idx]] = [nextOrder[idx], nextOrder[idx + 1]];
                  this.saveStructuredAnswer(question, { order: nextOrder });
                }}>↓</button>
              </div>
            </div>`;
          })}
        </div>
      `;
    }

    return '';
  }

  renderExam() {
    const question = this.attempt?.questions?.[this.currentQuestion];
    if (!question) return html`<main class="exam-loading"><div class="loader-dot"></div><p>Preparing your examination…</p></main>`;
    const answered = Object.values(this.answers).filter(Boolean).length;
    const total = this.attempt.questions.length;
    const progress = (answered / total) * 100;
    const title = this.settings.site_title || 'Northstar';
    const subtitle = this.settings.site_subtitle || 'EXAMINATION PORTAL';
    return html`<main class="exam-player">
      <div class="exam-player-top"><button class="brand" @click=${async () => { if (await this.confirmMessage('Leave this exam? You can return using this browser session.', { label: 'Leave exam' })) { this.page = 'home'; this.requestUpdate(); } }}><span class="brand-mark">${title.charAt(0).toUpperCase()}</span><span>${title.toLowerCase()}<span class="brand-dot">.</span><small>${subtitle.toUpperCase()}</small></span></button><div class="exam-live-meta"><span class="live-label"><span></span> IN PROGRESS</span><span class="timer-chip ${this.remainingSeconds < 300 ? 'timer-warning' : ''}"><span>◷</span>${htmlTime(this.remainingSeconds)}</span></div></div>
      <div class="exam-player-layout"><aside class="exam-sidebar"><div class="sidebar-exam-info"><span class="eyebrow muted">EXAMINATION</span><h2>${this.attempt.exam_title}</h2><p>${this.attempt.student_name}<span> · Roll ${this.attempt.roll_number}</span></p></div><div class="sidebar-progress"><div><span>YOUR PROGRESS</span><b>${answered} <small>/ ${total}</small></b></div><div class="progress-track"><span style="width:${progress}%"></span></div><p>${answered === total ? 'You have answered every question.' : `${total - answered} questions remaining`}</p></div><div class="question-nav-label"><span>QUESTION NAVIGATOR</span><span>${answered} answered</span></div><div class="question-nav">${this.attempt.questions.map((item, index) => html`<button class="question-nav-item ${index === this.currentQuestion ? 'current' : ''} ${this.answers[item.id] ? 'answered' : ''}" @click=${() => { this.goToQuestion(index); }} aria-label=${`Question ${index + 1}${this.answers[item.id] ? ', answered' : ''}`}><span>${String(index + 1).padStart(2, '0')}</span>${this.answers[item.id] ? html`<span class="nav-check">✓</span>` : ''}</button>`)}</div><div class="nav-legend"><span><i class="legend-current"></i>Current</span><span><i class="legend-done"></i>Answered</span><span><i class="legend-empty"></i>Unanswered</span></div><div class="autosave-note"><span>✓</span> Answers save as you go</div></aside>
        <section class="question-stage"><div class="question-stage-top"><span>QUESTION <b>${String(this.currentQuestion + 1).padStart(2, '0')}</b> <i>OF</i> ${String(total).padStart(2, '0')}</span><span class="mark-chip">${question.marks} MARK</span></div><div class="question-progress"><span style="width:${((this.currentQuestion + 1) / total) * 100}%"></span></div><div class="question-content">
          ${question.stimulus ? html`
            <div class="stimulus-panel">
              <span class="eyebrow stimulus-eyebrow">READING / REFERENCE STIMULUS</span>
              ${question.stimulus.title ? html`<h3 class="stimulus-title">${question.stimulus.title}</h3>` : ''}
              ${question.stimulus.text ? html`<div class="stimulus-text">${unsafeHTML(sanitizeRichText(question.stimulus.text))}</div>` : ''}
              ${question.stimulus.media?.url ? html`
                <figure class="question-media-box stimulus-media">
                  ${question.stimulus.media.type === 'audio'
                    ? html`<audio controls preload="metadata" src=${question.stimulus.media.url}></audio>`
                    : html`<img src=${question.stimulus.media.url} alt=${question.stimulus.title || 'Stimulus media'} />`}
                </figure>
              ` : ''}
            </div>
          ` : ''}
          <div class="question-step">${String(this.currentQuestion + 1).padStart(2, '0')} <span>—</span> ${String(total).padStart(2, '0')}</div><h1>${unsafeHTML(renderQuestionText(question.question_text))}</h1>
          ${question.media?.url ? html`<figure class="question-media-box">${question.media.type === 'audio' ? html`<audio controls preload="metadata" src=${question.media.url}></audio>` : html`<img src=${question.media.url} alt=${question.media.alt || question.question_text} />`}${question.media.caption ? html`<figcaption>${question.media.caption}</figcaption>` : ''}</figure>` : ''}
          ${this.renderStudentQuestionInput(question)}
        </div><div class="question-actions"><button class="button button-outline" ?disabled=${this.currentQuestion === 0} @click=${() => { this.goToQuestion(this.currentQuestion - 1); }}>← <span>Previous</span></button><span class="save-state"><span class="save-dot"></span> ${this.pendingAnswerSaves ? 'Saving…' : 'Saved automatically'}</span>${this.currentQuestion < total - 1 ? html`<button class="button button-primary" @click=${() => { this.goToQuestion(this.currentQuestion + 1); }}>Next question <span>→</span></button>` : html`<button class="button button-primary" @click=${() => this.submitAttempt(false)} ?disabled=${this.busy}>Submit exam <span>→</span></button>`}</div><button class="submit-text" @click=${() => this.submitAttempt(false)}>Submit examination</button></section>
      </div><footer class="exam-player-footer"><span>${title} Examination Portal</span><span>Need a moment? Your answers are saved automatically.</span></footer>
    </main>`;
  }

  renderStudentResult() {
    const result = this.attempt?.result || {};
    const reviewed = result.answers || [];
    return html`<main class="result-page"><div class="result-card"><div class="result-success-icon">✓</div><span class="eyebrow muted">EXAMINATION COMPLETE</span><h1>${this.attempt?.exam_title || 'Your examination'}</h1><p class="result-greeting">Well done, ${this.attempt?.student_name || 'student'}.</p><div class="result-message">Your exam has been submitted successfully.</div>
      ${Object.hasOwn(result, 'score') ? html`<div class="student-score"><span>YOUR SCORE</span><strong>${result.score}<small> / ${this.attempt.questions.length}</small></strong><p>${result.status === 'auto_submitted' ? 'Submitted automatically when time expired' : 'Your examination has been submitted'}</p></div>` : ''}
      ${reviewed.length ? html`<div class="student-review"><div class="review-heading"><h2>Answer review</h2><span>${reviewed.filter((answer) => answer.is_correct).length} of ${reviewed.length} correct</span></div>${reviewed.map((answer, index) => {
        const answered = isAnswerProvided(answer, answer.selected_option, answer.answer_data);
        const partial = !answer.is_correct && answered && Number(answer.marks_awarded) > 0;
        return html`<article class="review-item ${answer.is_correct ? 'is-correct' : partial ? 'is-partial' : answered ? 'is-wrong' : 'is-pending'}"><div class="review-item-head"><span>QUESTION ${String(index + 1).padStart(2, '0')}</span><b>${answer.is_correct ? '✓ Correct' : partial ? 'Partial credit' : answered ? '× Incorrect' : 'Not answered'}</b></div><h3>${unsafeHTML(renderQuestionText(answer.question_text))}</h3><p>Your answer: <strong>${formatStudentAnswerSummary(answer)}</strong></p><p>Correct answer: <strong>${formatCorrectAnswerSummary(answer)}</strong></p>${answer.explanation ? html`<p class="answer-explanation"><b>Explanation</b> ${unsafeHTML(sanitizeRichText(answer.explanation))}</p>` : ''}<span class="review-mark">${answer.marks_awarded ?? 0} / ${answer.marks} mark</span></article>`;
      })}</div>` : ''}
      ${(result.allow_pdf_download || this.attempt?.allow_pdf_download) && reviewed.length ? html`<div class="result-download-section"><button class="button button-outline button-full download-pdf-btn" @click=${() => this.downloadResultPdf()}>↓ Download result as PDF</button></div>` : ''}
      <button class="button button-primary button-full" @click=${this.newAttempt}>Return to examinations <span>→</span></button>
    </div></main>`;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('mcq-app')) {
  customElements.define('mcq-app', McqApp);
}
