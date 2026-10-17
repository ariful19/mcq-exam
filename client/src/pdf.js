import { jsPDF } from 'jspdf';
import {
  QUESTION_TYPES,
  isAnswerProvided,
  formatStudentAnswerSummary,
  formatCorrectAnswerSummary,
} from './question-authoring.js';

const optionKeys = { A: 'option_a', B: 'option_b', C: 'option_c', D: 'option_d' };

export function cleanText(text) {
  if (text === null || text === undefined) return '';
  let str = String(text)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u2022\u2023\u25E6\u2043\u2219]/g, '-')
    .replace(/\u2713/g, '')
    .replace(/\u2717/g, '');

  // Strip characters outside standard printable ASCII (32-126) and newline
  str = str.replace(/[^\x20-\x7E\n]/g, '');

  // Clean up empty parentheses/brackets or dangling punctuation left by stripped non-ASCII
  str = str.replace(/\(\s*\)/g, '');
  str = str.replace(/\[\s*\]/g, '');
  str = str.replace(/,\s*,/g, ',');
  str = str.replace(/,\s*$/g, '');
  return str.replace(/[ \t]+/g, ' ').trim();
}

export function fitText(doc, text, maxWidth) {
  const str = cleanText(text);
  if (doc.getTextWidth(str) <= maxWidth) return str;
  let truncated = str;
  while (truncated.length > 3 && doc.getTextWidth(truncated + '...') > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated.trim() + '...';
}

export function generateResultPdf({ attempt, result, settings = {} }) {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 15;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  const siteTitle = (cleanText(settings.site_title) || 'NORTHSTAR').toUpperCase();
  const siteSubtitle = cleanText(settings.site_subtitle) || 'EXAMINATION PORTAL';
  const examTitle = cleanText(attempt.exam_title) || 'Examination';
  const studentName = cleanText(attempt.student_name) || 'Candidate';
  const rollNumber = cleanText(attempt.roll_number) || 'N/A';
  const email = cleanText(attempt.email) || '';
  const address = cleanText(attempt.address) || '';
  const answers = result.answers || [];
  const status = cleanText((result.status || attempt.status || 'submitted').replace('_', ' ').toUpperCase());

  const correctCount = answers.filter((a) => a.is_correct).length;
  const answeredCount = answers.filter((a) => isAnswerProvided(a, a.selected_option, a.answer_data)).length;
  const incorrectCount = answeredCount - correctCount;
  const unansweredCount = answers.length - answeredCount;

  function ensureSpace(neededHeight) {
    if (y + neededHeight > pageHeight - 20) {
      doc.addPage();
      y = margin;
      drawPageHeader(true);
    }
  }

  function drawPageHeader(isContinuation = false) {
    // Top accent bar (Indigo #4f46e5)
    doc.setFillColor(79, 70, 229);
    doc.rect(margin, y, contentWidth, 2, 'F');
    y += 5;

    if (!isContinuation) {
      // Row 1: Site Title (Left) + Document Title (Right)
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(15);
      doc.setTextColor(30, 41, 59); // Slate 800
      doc.text(siteTitle, margin, y + 4);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(79, 70, 229); // Indigo 600
      const reportTitle = 'OFFICIAL RESULT SHEET';
      doc.text(reportTitle, pageWidth - margin - doc.getTextWidth(reportTitle), y + 4);

      // Row 2: Subtitle (Left) + Generation date (Right)
      y += 5.5;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(100, 116, 139); // Slate 500
      doc.text(siteSubtitle, margin, y + 3);

      const genDateText = `Generated: ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
      doc.setFontSize(8);
      doc.setTextColor(148, 163, 184); // Slate 400
      doc.text(genDateText, pageWidth - margin - doc.getTextWidth(genDateText), y + 3);

      y += 6;
      doc.setDrawColor(226, 232, 240); // Slate 200
      doc.setLineWidth(0.3);
      doc.line(margin, y, pageWidth - margin, y);
      y += 5;
    } else {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      const continuationText = `${siteTitle} | ${examTitle} - Candidate: ${studentName} (Roll: ${rollNumber})`;
      doc.text(fitText(doc, continuationText, contentWidth - 25), margin, y + 3);

      doc.setFontSize(7.5);
      doc.setTextColor(148, 163, 184);
      doc.text('Continued', pageWidth - margin - 15, y + 3);

      y += 5;
      doc.setDrawColor(226, 232, 240);
      doc.setLineWidth(0.2);
      doc.line(margin, y, pageWidth - margin, y);
      y += 4;
    }
  }

  // Draw main header
  drawPageHeader(false);

  // Candidate and Exam Information Card
  const cardHeight = 31;
  doc.setFillColor(248, 250, 252); // Slate 50
  doc.setDrawColor(226, 232, 240); // Slate 200
  doc.setLineWidth(0.3);
  doc.roundedRect(margin, y, contentWidth, cardHeight, 2, 2, 'FD');

  const halfWidth = contentWidth / 2;
  const col1X = margin + 4;
  const col2X = margin + halfWidth + 4;
  const colMaxValWidth = halfWidth - 28;

  // Divider lines inside card
  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.2);
  doc.line(margin + halfWidth, y + 3, margin + halfWidth, y + 21);
  doc.line(margin + 4, y + 22.5, margin + contentWidth - 4, y + 22.5);

  doc.setFontSize(8.5);

  // Col 1 Row 1: Candidate Name
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(71, 85, 105);
  doc.text('Candidate:', col1X, y + 5.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(15, 23, 42);
  doc.text(fitText(doc, studentName, colMaxValWidth), col1X + 22, y + 5.5);

  // Col 1 Row 2: Roll Number
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(71, 85, 105);
  doc.text('Roll Number:', col1X, y + 11);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(15, 23, 42);
  doc.text(fitText(doc, rollNumber, colMaxValWidth), col1X + 22, y + 11);

  // Col 1 Row 3: Email
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(71, 85, 105);
  doc.text('Email:', col1X, y + 16.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(15, 23, 42);
  doc.text(fitText(doc, email || 'Not provided', colMaxValWidth), col1X + 22, y + 16.5);

  // Col 2 Row 1: Exam Title
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(71, 85, 105);
  doc.text('Exam:', col2X, y + 5.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(15, 23, 42);
  doc.text(fitText(doc, examTitle, colMaxValWidth), col2X + 22, y + 5.5);

  // Col 2 Row 2: Status & Total Questions
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(71, 85, 105);
  doc.text('Status:', col2X, y + 11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(16, 185, 129); // Emerald 500
  doc.text(status, col2X + 22, y + 11);

  doc.setFont('helvetica', 'bold');
  doc.setTextColor(71, 85, 105);
  doc.text('Total Qs:', col2X + 46, y + 11);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(15, 23, 42);
  doc.text(String(answers.length), col2X + 61, y + 11);

  // Col 2 Row 3: Submitted Date
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(71, 85, 105);
  doc.text('Submitted:', col2X, y + 16.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(15, 23, 42);
  const subDate = result.submittedAt ? new Date(result.submittedAt).toLocaleString() : 'N/A';
  doc.text(fitText(doc, subDate, colMaxValWidth), col2X + 22, y + 16.5);

  // Row 4: Full-width Address spanning the entire bottom of the card
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(71, 85, 105);
  doc.text('Address:', col1X, y + 27.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(15, 23, 42);
  doc.text(fitText(doc, address || 'Not provided', contentWidth - 28), col1X + 22, y + 27.5);

  y += cardHeight + 5;

  // Score Summary - 4 clean metric tiles
  const tileGap = 3;
  const tileWidth = (contentWidth - tileGap * 3) / 4;
  const tileHeight = 15;
  const scoreDisplay = Object.hasOwn(result, 'score') && result.score !== null ? `${result.score} / ${answers.length}` : 'Pending';
  const tiles = [
    { label: 'FINAL SCORE', value: scoreDisplay, bg: [238, 242, 255], border: [199, 210, 254], labelColor: [67, 56, 202], valColor: [49, 46, 129] },
    { label: 'CORRECT', value: String(correctCount), bg: [240, 253, 244], border: [187, 247, 208], labelColor: [21, 128, 61], valColor: [22, 101, 52] },
    { label: 'INCORRECT', value: String(incorrectCount), bg: [254, 242, 242], border: [254, 202, 202], labelColor: [185, 28, 28], valColor: [153, 27, 27] },
    { label: 'UNANSWERED', value: String(unansweredCount), bg: [248, 250, 252], border: [226, 232, 240], labelColor: [71, 85, 105], valColor: [30, 41, 59] },
  ];

  tiles.forEach((t, i) => {
    const tx = margin + i * (tileWidth + tileGap);
    doc.setFillColor(...t.bg);
    doc.setDrawColor(...t.border);
    doc.setLineWidth(0.3);
    doc.roundedRect(tx, y, tileWidth, tileHeight, 1.5, 1.5, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.8);
    doc.setTextColor(...t.labelColor);
    doc.text(t.label, tx + 3, y + 4.8);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...t.valColor);
    doc.text(t.value, tx + 3, y + 11.5);
  });

  y += tileHeight + 2.5;

  const accuracy = answeredCount > 0 ? Math.round((correctCount / answeredCount) * 100) : 0;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(100, 116, 139);
  doc.text(`Performance: ${accuracy}% accuracy across ${answeredCount} attempted question${answeredCount === 1 ? '' : 's'}.`, margin + 1, y + 2.5);

  y += 7;

  // Answer Sheet Heading
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.setTextColor(30, 41, 59);
  doc.text('ANSWER SHEET WITH EXPLANATIONS', margin, y);
  y += 4;

  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.2);
  doc.line(margin, y, pageWidth - margin, y);
  y += 4;

  // Questions Loop
  answers.forEach((q, index) => {
    const qType = q.question_type || QUESTION_TYPES.MCQ_SINGLE;
    const isCorrect = Boolean(q.is_correct);
    const isAnswered = isAnswerProvided(q, q.selected_option, q.answer_data);

    const marksAwarded = Number(q.marks_awarded ?? 0);
    const signedMarks = `${marksAwarded >= 0 ? '+' : ''}${marksAwarded.toFixed(2)}`;
    const statusText = isCorrect
      ? `CORRECT (${signedMarks})`
      : isAnswered
        ? marksAwarded > 0
          ? `PARTIAL CREDIT (${signedMarks})`
          : `INCORRECT (${marksAwarded.toFixed(2)})`
        : 'NOT ANSWERED (0.00)';

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    const badgeTextWidth = doc.getTextWidth(statusText);
    const badgeWidth = badgeTextWidth + 6;
    const badgeHeight = 5;

    const qNum = `Q${index + 1}. `;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    const qNumWidth = doc.getTextWidth(qNum);
    const maxQTextWidth = contentWidth - badgeWidth - qNumWidth - 10;
    const cleanQText = cleanText(q.question_text || '');
    const qLines = doc.splitTextToSize(cleanQText, maxQTextWidth);
    const qTextHeight = Math.max(qLines.length * 4.2, 5);

    doc.setFontSize(8);
    const optColWidth = (contentWidth - 8) / 2;
    const optLabels = {};
    const optHeights = {};
    let row1Height = 0;
    let row2Height = 0;
    let nonMcqStudentLines = [];
    let nonMcqCorrectLines = [];

    if (qType === QUESTION_TYPES.MCQ_SINGLE) {
      ['A', 'B', 'C', 'D'].forEach((letter) => {
        const isSelected = q.selected_option === letter;
        const isRight = q.correct_option === letter;
        let tag = '';
        if (isRight && isSelected) tag = ' [Correct] [Your Answer]';
        else if (isRight) tag = ' [Correct]';
        else if (isSelected) tag = ' [Your Answer]';

        const optText = `${letter}. ${cleanText(q[optionKeys[letter]] || '')}${tag}`;
        const lines = doc.splitTextToSize(optText, optColWidth - 4);
        optLabels[letter] = lines;
        optHeights[letter] = lines.length * 3.8;
      });
      row1Height = Math.max(optHeights.A, optHeights.B);
      row2Height = Math.max(optHeights.C, optHeights.D);
    } else {
      const studentAnsText = `Your Answer: ${cleanText(formatStudentAnswerSummary(q))}`;
      const correctAnsText = `Correct Answer: ${cleanText(formatCorrectAnswerSummary(q))}`;
      nonMcqStudentLines = doc.splitTextToSize(studentAnsText, contentWidth - 10);
      nonMcqCorrectLines = doc.splitTextToSize(correctAnsText, contentWidth - 10);
      row1Height = nonMcqStudentLines.length * 3.8;
      row2Height = nonMcqCorrectLines.length * 3.8;
    }

    const optsTotalHeight = row1Height + row2Height + 4;

    let expHeight = 0;
    let expLines = [];
    const cleanExp = cleanText(q.explanation || '');
    if (cleanExp) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.8);
      expLines = doc.splitTextToSize(`Explanation: ${cleanExp}`, contentWidth - 14);
      expHeight = expLines.length * 3.6 + 5;
    }

    const cardPaddingTop = 4;
    const cardPaddingBottom = 4;
    const totalQBlockHeight = cardPaddingTop + qTextHeight + 2 + optsTotalHeight + (expHeight ? expHeight + 2 : 0) + cardPaddingBottom;

    ensureSpace(totalQBlockHeight + 3);

    // Card background & border
    if (isCorrect) {
      doc.setFillColor(240, 253, 244);
      doc.setDrawColor(187, 247, 208);
    } else if (isAnswered) {
      doc.setFillColor(254, 242, 242);
      doc.setDrawColor(254, 202, 202);
    } else {
      doc.setFillColor(248, 250, 252);
      doc.setDrawColor(226, 232, 240);
    }
    doc.setLineWidth(0.25);
    doc.roundedRect(margin, y, contentWidth, totalQBlockHeight, 1.5, 1.5, 'FD');

    // Status badge pill in top right corner
    const badgeX = margin + contentWidth - badgeWidth - 3;
    const badgeY = y + 3;
    if (isCorrect) {
      doc.setFillColor(220, 252, 231);
      doc.setDrawColor(134, 239, 172);
    } else if (isAnswered) {
      doc.setFillColor(254, 226, 226);
      doc.setDrawColor(252, 165, 165);
    } else {
      doc.setFillColor(241, 245, 249);
      doc.setDrawColor(203, 213, 225);
    }
    doc.setLineWidth(0.2);
    doc.roundedRect(badgeX, badgeY, badgeWidth, badgeHeight, 1, 1, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    if (isCorrect) doc.setTextColor(22, 101, 52);
    else if (isAnswered) doc.setTextColor(153, 27, 27);
    else doc.setTextColor(71, 85, 105);
    doc.text(statusText, badgeX + 3, badgeY + 3.6);

    // Question number & text
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(30, 41, 59);
    doc.text(qNum, margin + 4, y + 5);
    doc.text(qLines, margin + 4 + qNumWidth, y + 5);

    let curY = y + cardPaddingTop + qTextHeight + 2;

    if (qType === QUESTION_TYPES.MCQ_SINGLE) {
      // Render Options (2 columns)
      const optX1 = margin + 4;
      const optX2 = margin + halfWidth + 1;

      const printOption = (letter, x, optY) => {
        const isSelected = q.selected_option === letter;
        const isRight = q.correct_option === letter;

        if (isRight) {
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(21, 128, 61); // Green 700
        } else if (isSelected) {
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(185, 28, 28); // Red 700
        } else {
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(71, 85, 105); // Slate 600
        }
        doc.setFontSize(8);
        doc.text(optLabels[letter], x, optY);
      };

      printOption('A', optX1, curY);
      printOption('B', optX2, curY);
      curY += row1Height + 1.5;

      printOption('C', optX1, curY);
      printOption('D', optX2, curY);
      curY += row2Height + 2.5;
    } else {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      if (isCorrect) doc.setTextColor(21, 128, 61);
      else if (isAnswered) doc.setTextColor(185, 28, 28);
      else doc.setTextColor(71, 85, 105);
      doc.text(nonMcqStudentLines, margin + 4, curY);
      curY += row1Height + 1.5;

      doc.setFont('helvetica', 'bold');
      doc.setTextColor(21, 128, 61);
      doc.text(nonMcqCorrectLines, margin + 4, curY);
      curY += row2Height + 2.5;
    }

    // Explanation Box
    if (expLines.length) {
      doc.setFillColor(255, 255, 255);
      doc.setDrawColor(203, 213, 225);
      doc.setLineWidth(0.2);
      doc.roundedRect(margin + 3, curY, contentWidth - 6, expHeight, 1, 1, 'FD');

      doc.setFillColor(59, 130, 246);
      doc.rect(margin + 3, curY, 1.2, expHeight, 'F');

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.8);
      doc.setTextColor(51, 65, 85);
      doc.text(expLines, margin + 7, curY + 3.8);
      curY += expHeight;
    }

    y += totalQBlockHeight + 3;
  });

  // Add Page Numbers and Footers to all pages
  const totalPages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i += 1) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(148, 163, 184);

    const footerText = `${siteTitle} | ${examTitle} - Official Result Document`;
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.2);
    doc.line(margin, pageHeight - 11, pageWidth - margin, pageHeight - 11);

    doc.text(footerText, margin, pageHeight - 7);

    const pageNumText = `Page ${i} of ${totalPages}`;
    doc.text(pageNumText, pageWidth - margin - doc.getTextWidth(pageNumText), pageHeight - 7);
  }

  // Trigger download
  const safeStudent = (cleanText(studentName) || 'Candidate').replace(/[^a-z0-9_-]/gi, '_');
  const safeRoll = (cleanText(rollNumber) || 'N/A').replace(/[^a-z0-9_-]/gi, '_');
  const safeExam = (cleanText(examTitle) || 'Exam').replace(/[^a-z0-9_-]/gi, '_');
  const filename = `${safeStudent}_${safeRoll}_${safeExam}_Result.pdf`;

  doc.save(filename);
  return filename;
}
