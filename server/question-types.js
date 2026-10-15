export const QUESTION_TYPES = Object.freeze({
  MCQ_SINGLE: 'mcq_single',
  MCQ_MULTI: 'mcq_multi',
  TRUE_FALSE: 'true_false',
  SHORT_ANSWER: 'short_answer',
  NUMERIC: 'numeric',
  MATCHING: 'matching',
  ORDERING: 'ordering',
});

export const SUPPORTED_QUESTION_TYPES = Object.freeze(Object.values(QUESTION_TYPES));
export const DEFAULT_QUESTION_TYPE = QUESTION_TYPES.MCQ_SINGLE;
export const ALLOWED_MEDIA_TYPES = Object.freeze(['image', 'audio']);
export const LEGACY_MCQ_LETTERS = Object.freeze(['A', 'B', 'C', 'D']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonValue(raw, fallback = null) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: fallback };
  if (typeof raw === 'object') return { ok: true, value: raw };
  if (typeof raw !== 'string') return { ok: false, value: fallback };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, value: fallback };
  }
}

export function buildLegacyMcqConfig(row = {}) {
  return {
    options: [
      { id: 'A', text: String(row.option_a ?? '').trim() },
      { id: 'B', text: String(row.option_b ?? '').trim() },
      { id: 'C', text: String(row.option_c ?? '').trim() },
      { id: 'D', text: String(row.option_d ?? '').trim() },
    ],
  };
}

export function buildLegacyMcqAnswerKey(row = {}) {
  const correctOption = String(row.correct_option ?? '').trim().toUpperCase();
  return correctOption ? { correct_option: correctOption } : {};
}

export function validateQuestionMedia(rawMedia) {
  const errors = [];
  if (rawMedia === undefined || rawMedia === null || rawMedia === '' || rawMedia === 'null') {
    return { media: null, mediaJson: null, errors };
  }
  const parsed = parseJsonValue(rawMedia, null);
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    return { media: null, mediaJson: null, errors: ['Question media must be a valid JSON object or null.'] };
  }
  const value = parsed.value;
  if (Object.keys(value).length === 0) {
    return { media: null, mediaJson: null, errors };
  }
  if (value.student_upload || value.allow_audio_upload || value.allow_video_upload) {
    errors.push('Student audio and video uploads are not supported.');
  }
  const type = String(value.type ?? '').trim().toLowerCase();
  if (type === 'video') {
    errors.push('Video questions and video media are not supported.');
  } else if (!ALLOWED_MEDIA_TYPES.includes(type)) {
    errors.push('Media type must be "image" or "audio".');
  }
  const url = String(value.url ?? '').trim();
  if (!url) {
    errors.push('Media url is required when media is provided.');
  } else if (url.length > 2048) {
    errors.push('Media url must be 2048 characters or fewer.');
  } else if (/^data:video\//i.test(url) || /^javascript:/i.test(url)) {
    errors.push('Media url uses an unsupported or unsafe protocol.');
  } else if (!/^(https?:\/\/|\/|data:image\/|data:audio\/)/i.test(url)) {
    errors.push('Media url must be an http(s) URL, relative path, or image/audio data URI.');
  }
  const alt = value.alt !== undefined && value.alt !== null ? String(value.alt).trim() : '';
  const caption = value.caption !== undefined && value.caption !== null ? String(value.caption).trim() : '';
  if (alt.length > 500) errors.push('Media alt text must be 500 characters or fewer.');
  if (caption.length > 500) errors.push('Media caption must be 500 characters or fewer.');

  if (errors.length) return { media: null, mediaJson: null, errors };
  const normalized = {
    type,
    url,
    ...(alt ? { alt } : {}),
    ...(caption ? { caption } : {}),
  };
  return { media: normalized, mediaJson: JSON.stringify(normalized), errors };
}

function detectForbiddenFeatures(input, configObj, answerKeyObj) {
  const errors = [];
  const sources = [input, configObj, answerKeyObj].filter(isPlainObject);
  for (const src of sources) {
    const gradingMode = String(src.grading_mode ?? src.gradingMode ?? '').trim().toLowerCase();
    if (
      src.use_ai || src.use_nlp || src.ai_grading || src.nlp_grading ||
      gradingMode === 'ai' || gradingMode === 'nlp' || gradingMode === 'llm'
    ) {
      errors.push('AI/NLP grading is not supported.');
    }
    const responseType = String(src.response_type ?? src.response_mode ?? '').trim().toLowerCase();
    if (
      src.allow_audio_upload || src.allow_video_upload ||
      src.student_audio_upload || src.student_video_upload ||
      responseType === 'audio' || responseType === 'video' || responseType === 'audio_upload' || responseType === 'video_upload'
    ) {
      errors.push('Student audio and video uploads are not supported.');
    }
  }
  return [...new Set(errors)];
}

function validateOptionsList(optionsInput, { minCount = 2, maxCount = 8, exactIds = null } = {}) {
  const errors = [];
  if (!Array.isArray(optionsInput) || optionsInput.length < minCount || optionsInput.length > maxCount) {
    errors.push(`Options must be an array of ${minCount === maxCount ? minCount : `${minCount} to ${maxCount}`} items.`);
    return { options: [], errors };
  }
  const seenIds = new Set();
  const normalized = [];
  optionsInput.forEach((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`Option ${index + 1} must be an object with id and text.`);
      return;
    }
    const rawId = String(item.id ?? '').trim();
    const id = exactIds ? rawId : rawId.toUpperCase();
    const text = String(item.text ?? '').trim();
    if (!id) errors.push(`Option ${index + 1} id is required.`);
    else if (seenIds.has(id)) errors.push(`Duplicate option id "${id}" is not allowed.`);
    else seenIds.add(id);
    if (!text) errors.push(`Option ${id || index + 1} is required.`);
    normalized.push({ id, text });
  });
  if (exactIds && !errors.length) {
    const matchesExact = exactIds.length === normalized.length && exactIds.every((expectedId, idx) => normalized[idx]?.id === expectedId);
    if (!matchesExact) {
      errors.push(`Option ids must be ${exactIds.join(', ')}.`);
    }
  }
  return { options: normalized, errors };
}

export function normalizeQuestion(input = {}) {
  if (!isPlainObject(input)) {
    return { question: null, errors: ['Question payload must be a JSON object.'] };
  }

  const errors = [];

  // Resolve question_type (defaulting to mcq_single when omitted)
  const rawTypeField = input.question_type !== undefined ? input.question_type : input['Question Type'];
  let questionType = DEFAULT_QUESTION_TYPE;
  if (rawTypeField !== undefined && rawTypeField !== null && !(input.question_type === undefined && String(rawTypeField).trim() === '')) {
    if (typeof rawTypeField !== 'string' || !rawTypeField.trim()) {
      errors.push('Question type must be a non-empty string identifier.');
      questionType = '';
    } else {
      questionType = rawTypeField.trim().toLowerCase();
      if (questionType.includes('video')) {
        errors.push('Video questions and video media are not supported.');
      } else if (questionType.includes('audio') || questionType.includes('upload')) {
        errors.push('Student audio and video uploads are not supported.');
      } else if (questionType.includes('ai') || questionType.includes('nlp')) {
        errors.push('AI/NLP grading is not supported.');
      } else if (!SUPPORTED_QUESTION_TYPES.includes(questionType)) {
        errors.push(`Unsupported question type "${rawTypeField}". Supported types: ${SUPPORTED_QUESTION_TYPES.join(', ')}.`);
      }
    }
  }

  const questionText = String(input.question_text ?? input.Question ?? '').trim();
  const category = String(input.category ?? input.Category ?? input.subject ?? input.Subject ?? '').trim();
  const difficulty = String(input.difficulty ?? input.Difficulty ?? '').trim();
  const explanation = String(input.explanation ?? input.Explanation ?? '').trim();

  if (!questionText) errors.push('Question is required.');

  const rawConfigInput = input.question_config ?? input['Question Config'];
  const parsedConfig = parseJsonValue(rawConfigInput, null);
  if (!parsedConfig.ok || (parsedConfig.value !== null && !isPlainObject(parsedConfig.value))) {
    errors.push('question_config must be a valid JSON object.');
  }
  const configInput = isPlainObject(parsedConfig.value) ? parsedConfig.value : {};

  const rawAnswerKeyInput = input.answer_key ?? input['Answer Key'];
  const parsedAnswerKey = parseJsonValue(rawAnswerKeyInput, null);
  if (!parsedAnswerKey.ok || (parsedAnswerKey.value !== null && !isPlainObject(parsedAnswerKey.value))) {
    errors.push('answer_key must be a valid JSON object.');
  }
  const answerKeyInput = isPlainObject(parsedAnswerKey.value) ? parsedAnswerKey.value : {};

  // Reject any embedded category/media mix-ups inside question_config or answer_key
  if ('media' in configInput && configInput.media !== undefined) {
    errors.push('Media must be provided in the top-level media field, separate from question_config.');
  }
  if ('category' in configInput || 'subject' in configInput) {
    errors.push('Subject/category must be provided in the top-level category field, separate from question_config.');
  }

  errors.push(...detectForbiddenFeatures(input, configInput, answerKeyInput));

  const { mediaJson, errors: mediaErrors } = validateQuestionMedia(input.media ?? input.Media);
  errors.push(...mediaErrors);

  let optionA = String(input.option_a ?? input['Option A'] ?? '').trim();
  let optionB = String(input.option_b ?? input['Option B'] ?? '').trim();
  let optionC = String(input.option_c ?? input['Option C'] ?? '').trim();
  let optionD = String(input.option_d ?? input['Option D'] ?? '').trim();
  let correctOption = String(input.correct_option ?? input['Correct Answer'] ?? '').trim().toUpperCase();

  let normalizedConfig = {};
  let normalizedAnswerKey = {};

  if (questionType === QUESTION_TYPES.MCQ_SINGLE) {
    if (Array.isArray(configInput.options)) {
      const { options, errors: optErrors } = validateOptionsList(configInput.options, {
        minCount: 4,
        maxCount: 4,
        exactIds: LEGACY_MCQ_LETTERS,
      });
      errors.push(...optErrors);
      if (!optErrors.length) {
        const byId = Object.fromEntries(options.map((opt) => [opt.id, opt.text]));
        optionA = optionA || byId.A;
        optionB = optionB || byId.B;
        optionC = optionC || byId.C;
        optionD = optionD || byId.D;
      }
    } else if (configInput.options !== undefined) {
      errors.push('mcq_single question_config.options must be an array of 4 options (A, B, C, D).');
    } else {
      if (!optionA) errors.push('Option A is required.');
      if (!optionB) errors.push('Option B is required.');
      if (!optionC) errors.push('Option C is required.');
      if (!optionD) errors.push('Option D is required.');
    }

    const keyCorrect = answerKeyInput.correct_option !== undefined
      ? String(answerKeyInput.correct_option ?? '').trim().toUpperCase()
      : '';
    // If answer_key was explicitly passed as an object (not a leftover database JSON string from spreading a row) and conflicts with correct_option, reject
    if (isPlainObject(rawAnswerKeyInput) && correctOption && keyCorrect && correctOption !== keyCorrect) {
      errors.push('correct_option and answer_key.correct_option must match.');
    }
    if (!correctOption && keyCorrect) {
      correctOption = keyCorrect;
    }
    if (!LEGACY_MCQ_LETTERS.includes(correctOption)) {
      errors.push('Correct answer must be A, B, C or D.');
    }

    normalizedConfig = {
      options: [
        { id: 'A', text: optionA },
        { id: 'B', text: optionB },
        { id: 'C', text: optionC },
        { id: 'D', text: optionD },
      ],
    };
    normalizedAnswerKey = { correct_option: correctOption };
  } else if (questionType === QUESTION_TYPES.MCQ_MULTI) {
    let rawOptions = configInput.options;
    if (rawOptions === undefined && (optionA || optionB || optionC || optionD)) {
      rawOptions = [
        { id: 'A', text: optionA },
        { id: 'B', text: optionB },
        { id: 'C', text: optionC },
        { id: 'D', text: optionD },
      ];
    }
    const { options, errors: optErrors } = validateOptionsList(rawOptions, { minCount: 2, maxCount: 8 });
    errors.push(...optErrors);

    const rawCorrectOptions = answerKeyInput.correct_options ?? input.correct_options;
    const optionIdSet = new Set(options.map((opt) => opt.id));
    let correctOptions = [];
    if (!Array.isArray(rawCorrectOptions) || rawCorrectOptions.length < 1) {
      errors.push('mcq_multi requires answer_key.correct_options as a non-empty array of option IDs.');
    } else {
      const seenCorrect = new Set();
      rawCorrectOptions.forEach((val) => {
        const id = String(val ?? '').trim().toUpperCase();
        if (!optionIdSet.has(id)) {
          errors.push(`answer_key.correct_options contains unknown option id "${id}".`);
        } else if (seenCorrect.has(id)) {
          errors.push(`answer_key.correct_options contains duplicate option id "${id}".`);
        } else {
          seenCorrect.add(id);
          correctOptions.push(id);
        }
      });
    }

    const minSelections = configInput.min_selections !== undefined ? Number(configInput.min_selections) : undefined;
    const maxSelections = configInput.max_selections !== undefined ? Number(configInput.max_selections) : undefined;
    if (minSelections !== undefined && (!Number.isInteger(minSelections) || minSelections < 1 || minSelections > options.length)) {
      errors.push('min_selections must be an integer between 1 and the number of options.');
    }
    if (maxSelections !== undefined && (!Number.isInteger(maxSelections) || maxSelections < 1 || maxSelections > options.length)) {
      errors.push('max_selections must be an integer between 1 and the number of options.');
    }
    if (minSelections !== undefined && maxSelections !== undefined && minSelections > maxSelections) {
      errors.push('min_selections cannot exceed max_selections.');
    }

    const byId = Object.fromEntries(options.map((opt) => [opt.id, opt.text]));
    optionA = byId.A ?? '';
    optionB = byId.B ?? '';
    optionC = byId.C ?? '';
    optionD = byId.D ?? '';
    correctOption = '';

    normalizedConfig = {
      options,
      ...(minSelections !== undefined ? { min_selections: minSelections } : {}),
      ...(maxSelections !== undefined ? { max_selections: maxSelections } : {}),
    };
    normalizedAnswerKey = { correct_options: correctOptions };
  } else if (questionType === QUESTION_TYPES.TRUE_FALSE) {
    let options = [
      { id: 'true', text: 'True' },
      { id: 'false', text: 'False' },
    ];
    if (configInput.options !== undefined) {
      const { options: validatedOpts, errors: optErrors } = validateOptionsList(configInput.options, {
        minCount: 2,
        maxCount: 2,
        exactIds: ['true', 'false'],
      });
      errors.push(...optErrors);
      if (!optErrors.length) options = validatedOpts;
    }

    const rawCorrect = answerKeyInput.correct_answer !== undefined ? answerKeyInput.correct_answer : input.correct_answer;
    let boolAnswer = null;
    if (typeof rawCorrect === 'boolean') {
      boolAnswer = rawCorrect;
    } else if (typeof rawCorrect === 'string') {
      const lower = rawCorrect.trim().toLowerCase();
      if (lower === 'true') boolAnswer = true;
      else if (lower === 'false') boolAnswer = false;
    }
    if (boolAnswer === null) {
      errors.push('true_false requires a boolean answer_key.correct_answer (true or false).');
    }

    optionA = options[0]?.text || 'True';
    optionB = options[1]?.text || 'False';
    optionC = '';
    optionD = '';
    correctOption = '';
    normalizedConfig = { options };
    normalizedAnswerKey = { correct_answer: boolAnswer };
  } else if (questionType === QUESTION_TYPES.SHORT_ANSWER) {
    const rawAccepted = answerKeyInput.accepted_answers ?? input.accepted_answers;
    const acceptedAnswers = [];
    if (!Array.isArray(rawAccepted) || rawAccepted.length === 0 || rawAccepted.length > 25) {
      errors.push('short_answer requires answer_key.accepted_answers as a non-empty array of accepted strings.');
    } else {
      for (const item of rawAccepted) {
        if (typeof item !== 'string' || !item.trim()) {
          errors.push('Each entry in answer_key.accepted_answers must be a non-empty string.');
          break;
        }
        acceptedAnswers.push(item.trim());
      }
    }
    const caseSensitive = Boolean(answerKeyInput.case_sensitive ?? configInput.case_sensitive ?? false);
    const maxLength = configInput.max_length !== undefined ? Number(configInput.max_length) : 200;
    if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 500) {
      errors.push('short_answer question_config.max_length must be an integer between 1 and 500.');
    }
    const placeholder = configInput.placeholder !== undefined ? String(configInput.placeholder).trim().slice(0, 120) : '';

    optionA = '';
    optionB = '';
    optionC = '';
    optionD = '';
    correctOption = '';
    normalizedConfig = {
      case_sensitive: caseSensitive,
      max_length: maxLength,
      ...(placeholder ? { placeholder } : {}),
    };
    normalizedAnswerKey = {
      accepted_answers: acceptedAnswers,
      case_sensitive: caseSensitive,
    };
  } else if (questionType === QUESTION_TYPES.NUMERIC) {
    const rawVal = answerKeyInput.value !== undefined ? answerKeyInput.value : input.correct_value;
    const numericVal = typeof rawVal === 'number' ? rawVal : (typeof rawVal === 'string' && rawVal.trim() !== '' ? Number(rawVal) : NaN);
    if (!Number.isFinite(numericVal)) {
      errors.push('numeric requires a finite number in answer_key.value.');
    }
    const rawTolerance = answerKeyInput.tolerance !== undefined ? answerKeyInput.tolerance : 0;
    const tolerance = typeof rawTolerance === 'number' ? rawTolerance : (typeof rawTolerance === 'string' && rawTolerance.trim() !== '' ? Number(rawTolerance) : NaN);
    if (!Number.isFinite(tolerance) || tolerance < 0) {
      errors.push('numeric answer_key.tolerance must be a non-negative finite number.');
    }
    const unit = configInput.unit !== undefined ? String(configInput.unit).trim().slice(0, 40) : '';
    const placeholder = configInput.placeholder !== undefined ? String(configInput.placeholder).trim().slice(0, 120) : '';
    const allowDecimals = configInput.allow_decimals !== undefined ? Boolean(configInput.allow_decimals) : true;
    if (!allowDecimals && Number.isFinite(numericVal) && !Number.isInteger(numericVal)) {
      errors.push('answer_key.value must be an integer when allow_decimals is false.');
    }

    optionA = '';
    optionB = '';
    optionC = '';
    optionD = '';
    correctOption = '';
    normalizedConfig = {
      allow_decimals: allowDecimals,
      ...(unit ? { unit } : {}),
      ...(placeholder ? { placeholder } : {}),
    };
    normalizedAnswerKey = {
      value: numericVal,
      tolerance: Number.isFinite(tolerance) ? tolerance : 0,
    };
  } else if (questionType === QUESTION_TYPES.MATCHING) {
    const { options: prompts, errors: promptErrors } = validateOptionsList(configInput.prompts, { minCount: 2, maxCount: 10, exactIds: null });
    const { options: choices, errors: choiceErrors } = validateOptionsList(configInput.choices, { minCount: 2, maxCount: 12, exactIds: null });
    if (promptErrors.length) errors.push(...promptErrors.map((e) => `prompts: ${e}`));
    if (choiceErrors.length) errors.push(...choiceErrors.map((e) => `choices: ${e}`));
    if (!promptErrors.length && !choiceErrors.length && choices.length < prompts.length) {
      errors.push('matching requires at least as many choices as prompts.');
    }

    const rawPairs = answerKeyInput.pairs;
    const normalizedPairs = {};
    if (!isPlainObject(rawPairs)) {
      errors.push('matching requires answer_key.pairs as an object mapping prompt IDs to choice IDs.');
    } else if (!promptErrors.length && !choiceErrors.length) {
      const promptIds = new Set(prompts.map((p) => p.id));
      const choiceIds = new Set(choices.map((c) => c.id));
      for (const prompt of prompts) {
        const mapped = String(rawPairs[prompt.id] ?? rawPairs[prompt.id.toLowerCase()] ?? '').trim().toUpperCase();
        if (!mapped) {
          errors.push(`answer_key.pairs is missing a mapping for prompt "${prompt.id}".`);
        } else if (!choiceIds.has(mapped)) {
          errors.push(`answer_key.pairs maps prompt "${prompt.id}" to unknown choice "${mapped}".`);
        } else {
          normalizedPairs[prompt.id] = mapped;
        }
      }
      for (const key of Object.keys(rawPairs)) {
        if (!promptIds.has(String(key).trim().toUpperCase())) {
          errors.push(`answer_key.pairs contains unknown prompt id "${key}".`);
        }
      }
    }

    optionA = '';
    optionB = '';
    optionC = '';
    optionD = '';
    correctOption = '';
    normalizedConfig = { prompts, choices };
    normalizedAnswerKey = { pairs: normalizedPairs };
  } else if (questionType === QUESTION_TYPES.ORDERING) {
    const { options: items, errors: itemErrors } = validateOptionsList(configInput.items, { minCount: 2, maxCount: 10, exactIds: null });
    if (itemErrors.length) errors.push(...itemErrors.map((e) => `items: ${e}`));

    const rawOrder = answerKeyInput.correct_order ?? input.correct_order;
    const correctOrder = [];
    if (!Array.isArray(rawOrder)) {
      errors.push('ordering requires answer_key.correct_order as an array of item IDs.');
    } else if (!itemErrors.length) {
      const itemIds = new Set(items.map((item) => item.id));
      const seenOrder = new Set();
      for (const val of rawOrder) {
        const id = String(val ?? '').trim().toUpperCase();
        if (!itemIds.has(id)) {
          errors.push(`answer_key.correct_order contains unknown item id "${id}".`);
        } else if (seenOrder.has(id)) {
          errors.push(`answer_key.correct_order contains duplicate item id "${id}".`);
        } else {
          seenOrder.add(id);
          correctOrder.push(id);
        }
      }
      if (correctOrder.length !== items.length) {
        errors.push('answer_key.correct_order must include every item id exactly once.');
      }
    }

    optionA = '';
    optionB = '';
    optionC = '';
    optionD = '';
    correctOption = '';
    normalizedConfig = { items };
    normalizedAnswerKey = { correct_order: correctOrder };
  }

  if (!category) errors.push('Subject is required.');

  const question = {
    question_text: questionText,
    question_type: questionType || DEFAULT_QUESTION_TYPE,
    option_a: optionA,
    option_b: optionB,
    option_c: optionC,
    option_d: optionD,
    correct_option: correctOption,
    question_config: JSON.stringify(normalizedConfig),
    answer_key: JSON.stringify(normalizedAnswerKey),
    media: mediaJson,
    category,
    difficulty,
    explanation,
  };

  return { question, errors };
}

export function hydrateQuestionRow(row, { includeAnswerKey = true } = {}) {
  if (!row) return null;
  const questionType = String(row.question_type || DEFAULT_QUESTION_TYPE).trim() || DEFAULT_QUESTION_TYPE;

  const parsedConfig = parseJsonValue(row.question_config, null);
  let questionConfig = isPlainObject(parsedConfig.value) && Object.keys(parsedConfig.value).length > 0
    ? { ...parsedConfig.value }
    : (questionType === QUESTION_TYPES.MCQ_SINGLE ? buildLegacyMcqConfig(row) : {});
  delete questionConfig.answer_key;
  delete questionConfig.correct_option;
  delete questionConfig.correct_options;
  delete questionConfig.correct_answer;

  const parsedAnswerKey = parseJsonValue(row.answer_key, null);
  const answerKey = isPlainObject(parsedAnswerKey.value) && Object.keys(parsedAnswerKey.value).length > 0
    ? parsedAnswerKey.value
    : (questionType === QUESTION_TYPES.MCQ_SINGLE ? buildLegacyMcqAnswerKey(row) : {});

  const parsedMedia = parseJsonValue(row.media, null);
  const media = isPlainObject(parsedMedia.value) && Object.keys(parsedMedia.value).length > 0 ? parsedMedia.value : null;

  if (!includeAnswerKey) {
    return {
      id: row.id,
      question_text: row.question_text,
      question_type: questionType,
      option_a: row.option_a ?? '',
      option_b: row.option_b ?? '',
      option_c: row.option_c ?? '',
      option_d: row.option_d ?? '',
      question_config: questionConfig,
      media,
      marks: row.marks,
      sort_order: row.sort_order,
    };
  }

  return {
    ...row,
    question_type: questionType,
    question_config: questionConfig,
    answer_key: answerKey,
    media,
  };
}

export function hydrateAnswerRow(row, { forActiveAttempt = false } = {}) {
  if (!row) return null;
  const parsedAnswerData = parseJsonValue(row.answer_data, null);
  let answerData = isPlainObject(parsedAnswerData.value) ? parsedAnswerData.value : null;
  if (!answerData && row.selected_option !== undefined && row.selected_option !== null && row.selected_option !== '') {
    answerData = { selected_option: row.selected_option };
  }
  if (forActiveAttempt) {
    return {
      question_id: row.question_id,
      selected_option: row.selected_option ?? null,
      answer_data: answerData,
    };
  }
  const hydratedQuestion = hydrateQuestionRow(row, { includeAnswerKey: true });
  return {
    ...row,
    question_type: hydratedQuestion.question_type,
    question_config: hydratedQuestion.question_config,
    answer_key: hydratedQuestion.answer_key,
    media: hydratedQuestion.media,
    answer_data: answerData,
  };
}

export function validateStudentAnswer(questionRow, body = {}) {
  if (!questionRow) {
    return { selected_option: null, answer_data: null, answerDataJson: null, error: 'That question is not part of this examination.' };
  }
  const hydrated = hydrateQuestionRow(questionRow, { includeAnswerKey: true });
  const qType = hydrated.question_type;
  const qConfig = hydrated.question_config || {};

  // Reject any attempt to upload student audio/video in answer payload
  if (isPlainObject(body)) {
    const rawData = isPlainObject(body.answer_data) ? body.answer_data : body;
    if (
      rawData.audio_upload || rawData.video_upload || rawData.media_upload ||
      rawData.type === 'audio' || rawData.type === 'video'
    ) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: 'Student audio and video uploads are not supported.' };
    }
  }

  const hasAnswerData = body.answer_data !== undefined;
  const parsedData = hasAnswerData ? parseJsonValue(body.answer_data, null) : { ok: true, value: null };
  if (!parsedData.ok || (parsedData.value !== null && !isPlainObject(parsedData.value))) {
    return { selected_option: null, answer_data: null, answerDataJson: null, error: 'answer_data must be a valid JSON object or null.' };
  }
  const dataObj = parsedData.value;

  if (qType === QUESTION_TYPES.MCQ_SINGLE) {
    let rawOption = body.selected_option;
    if (rawOption === undefined && dataObj && 'selected_option' in dataObj) {
      rawOption = dataObj.selected_option;
    }
    if (rawOption === undefined && hasAnswerData && dataObj === null) {
      rawOption = null;
    }
    const selectedOption = rawOption === null || rawOption === '' ? null : String(rawOption ?? '').toUpperCase();
    if (!['A', 'B', 'C', 'D', null].includes(selectedOption)) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: 'Choose option A, B, C or D.' };
    }
    const answerData = selectedOption ? { selected_option: selectedOption } : null;
    return {
      selected_option: selectedOption,
      answer_data: answerData,
      answerDataJson: answerData ? JSON.stringify(answerData) : null,
      error: null,
    };
  }

  if (qType === QUESTION_TYPES.MCQ_MULTI) {
    if ((hasAnswerData && dataObj === null) || (!hasAnswerData && (body.selected_option === null || body.selected_option === ''))) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: null };
    }
    const rawSelected = dataObj?.selected_options ?? body.selected_options;
    if (!Array.isArray(rawSelected)) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: 'Select one or more valid options.' };
    }
    if (rawSelected.length === 0) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: null };
    }
    const allowedIds = new Set((qConfig.options || []).map((opt) => opt.id));
    const selectedOptions = [];
    const seen = new Set();
    for (const item of rawSelected) {
      const id = String(item ?? '').trim().toUpperCase();
      if (!allowedIds.has(id)) {
        return { selected_option: null, answer_data: null, answerDataJson: null, error: `Invalid option "${id}".` };
      }
      if (!seen.has(id)) {
        seen.add(id);
        selectedOptions.push(id);
      }
    }
    if (qConfig.max_selections && selectedOptions.length > qConfig.max_selections) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: `Select at most ${qConfig.max_selections} options.` };
    }
    const answerData = { selected_options: selectedOptions };
    return { selected_option: null, answer_data: answerData, answerDataJson: JSON.stringify(answerData), error: null };
  }

  if (qType === QUESTION_TYPES.TRUE_FALSE) {
    if ((hasAnswerData && dataObj === null) || (!hasAnswerData && (body.selected_option === null || body.selected_option === ''))) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: null };
    }
    const rawVal = dataObj?.selected_answer !== undefined ? dataObj.selected_answer : (body.selected_answer !== undefined ? body.selected_answer : body.selected_option);
    if (rawVal === null || rawVal === '') {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: null };
    }
    let boolVal = null;
    if (typeof rawVal === 'boolean') boolVal = rawVal;
    else if (typeof rawVal === 'string') {
      const lower = rawVal.trim().toLowerCase();
      if (lower === 'true') boolVal = true;
      else if (lower === 'false') boolVal = false;
    }
    if (boolVal === null) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: 'Choose True or False.' };
    }
    const answerData = { selected_answer: boolVal };
    return { selected_option: null, answer_data: answerData, answerDataJson: JSON.stringify(answerData), error: null };
  }

  if (qType === QUESTION_TYPES.SHORT_ANSWER) {
    if ((hasAnswerData && dataObj === null) || (!hasAnswerData && (body.selected_option === null || body.selected_option === ''))) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: null };
    }
    const rawText = dataObj?.text !== undefined ? dataObj.text : body.text;
    if (rawText === null || rawText === '') {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: null };
    }
    if (typeof rawText !== 'string') {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: 'Short answer must be a text string.' };
    }
    const trimmed = rawText.trim();
    if (!trimmed) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: null };
    }
    const maxLen = Number(qConfig.max_length) || 500;
    if (trimmed.length > maxLen) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: `Answer must be ${maxLen} characters or fewer.` };
    }
    const answerData = { text: trimmed };
    return { selected_option: null, answer_data: answerData, answerDataJson: JSON.stringify(answerData), error: null };
  }

  if (qType === QUESTION_TYPES.NUMERIC) {
    if ((hasAnswerData && dataObj === null) || (!hasAnswerData && (body.selected_option === null || body.selected_option === ''))) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: null };
    }
    const rawValue = dataObj?.value !== undefined ? dataObj.value : body.value;
    if (rawValue === null || rawValue === '') {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: null };
    }
    const numValue = typeof rawValue === 'number' ? rawValue : (typeof rawValue === 'string' && rawValue.trim() !== '' ? Number(rawValue) : NaN);
    if (!Number.isFinite(numValue)) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: 'Enter a valid numeric answer.' };
    }
    if (qConfig.allow_decimals === false && !Number.isInteger(numValue)) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: 'Enter a whole number.' };
    }
    const answerData = { value: numValue };
    return { selected_option: null, answer_data: answerData, answerDataJson: JSON.stringify(answerData), error: null };
  }

  if (qType === QUESTION_TYPES.MATCHING) {
    if ((hasAnswerData && dataObj === null) || (!hasAnswerData && (body.selected_option === null || body.selected_option === ''))) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: null };
    }
    const rawPairs = dataObj?.pairs ?? body.pairs;
    if (rawPairs === null) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: null };
    }
    if (!isPlainObject(rawPairs)) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: 'Matching answer requires a pairs object.' };
    }
    const entries = Object.entries(rawPairs).filter(([, v]) => v !== null && v !== '');
    if (entries.length === 0) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: null };
    }
    const promptIds = new Set((qConfig.prompts || []).map((p) => p.id));
    const choiceIds = new Set((qConfig.choices || []).map((c) => c.id));
    const normalizedPairs = {};
    for (const [k, v] of entries) {
      const pId = String(k).trim().toUpperCase();
      const cId = String(v).trim().toUpperCase();
      if (!promptIds.has(pId) || !choiceIds.has(cId)) {
        return { selected_option: null, answer_data: null, answerDataJson: null, error: 'Invalid matching prompt or choice identifier.' };
      }
      normalizedPairs[pId] = cId;
    }
    const answerData = { pairs: normalizedPairs };
    return { selected_option: null, answer_data: answerData, answerDataJson: JSON.stringify(answerData), error: null };
  }

  if (qType === QUESTION_TYPES.ORDERING) {
    if ((hasAnswerData && dataObj === null) || (!hasAnswerData && (body.selected_option === null || body.selected_option === ''))) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: null };
    }
    const rawOrder = dataObj?.order ?? body.order;
    if (rawOrder === null) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: null };
    }
    if (!Array.isArray(rawOrder)) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: 'Ordering answer requires an order array.' };
    }
    if (rawOrder.length === 0) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: null };
    }
    const itemIds = new Set((qConfig.items || []).map((item) => item.id));
    const seen = new Set();
    const order = [];
    for (const val of rawOrder) {
      const id = String(val ?? '').trim().toUpperCase();
      if (!itemIds.has(id) || seen.has(id)) {
        return { selected_option: null, answer_data: null, answerDataJson: null, error: 'Ordering answer must contain valid unique item IDs.' };
      }
      seen.add(id);
      order.push(id);
    }
    if (order.length !== itemIds.size) {
      return { selected_option: null, answer_data: null, answerDataJson: null, error: 'Ordering answer must include all items.' };
    }
    const answerData = { order };
    return { selected_option: null, answer_data: answerData, answerDataJson: JSON.stringify(answerData), error: null };
  }

  return { selected_option: null, answer_data: null, answerDataJson: null, error: `Unsupported question type "${qType}".` };
}

export function evaluateQuestionAnswer(questionRow, answerRow, negativeMark = 0) {
  const hydratedQuestion = hydrateQuestionRow(questionRow, { includeAnswerKey: true });
  const qType = hydratedQuestion.question_type;
  const answerKey = hydratedQuestion.answer_key || {};
  const marks = Number(hydratedQuestion.marks ?? 1);
  const penalty = Number(negativeMark || 0);

  if (!answerRow) {
    return { answered: false, isCorrect: false, marksAwarded: 0 };
  }

  const parsedAnswerData = parseJsonValue(answerRow.answer_data, null);
  const answerData = isPlainObject(parsedAnswerData.value) ? parsedAnswerData.value : null;

  if (qType === QUESTION_TYPES.MCQ_SINGLE) {
    const selected = answerRow.selected_option || answerData?.selected_option || null;
    const expected = hydratedQuestion.correct_option || answerKey.correct_option || '';
    const answered = Boolean(selected);
    const isCorrect = Boolean(answered && selected === expected);
    const marksAwarded = isCorrect ? marks : answered ? -penalty : 0;
    return { answered, isCorrect, marksAwarded };
  }

  if (qType === QUESTION_TYPES.MCQ_MULTI) {
    const selected = Array.isArray(answerData?.selected_options) ? answerData.selected_options : [];
    const answered = selected.length > 0;
    if (!answered) return { answered: false, isCorrect: false, marksAwarded: 0 };
    const expected = Array.isArray(answerKey.correct_options) ? answerKey.correct_options : [];
    const normSelected = [...new Set(selected.map((s) => String(s).toUpperCase()))].sort();
    const normExpected = [...new Set(expected.map((s) => String(s).toUpperCase()))].sort();
    const isCorrect = normSelected.length > 0 &&
      normSelected.length === normExpected.length &&
      normSelected.every((val, idx) => val === normExpected[idx]);
    return { answered: true, isCorrect, marksAwarded: isCorrect ? marks : -penalty };
  }

  if (qType === QUESTION_TYPES.TRUE_FALSE) {
    const selected = answerData?.selected_answer;
    const answered = typeof selected === 'boolean';
    if (!answered) return { answered: false, isCorrect: false, marksAwarded: 0 };
    const isCorrect = selected === Boolean(answerKey.correct_answer);
    return { answered: true, isCorrect, marksAwarded: isCorrect ? marks : -penalty };
  }

  if (qType === QUESTION_TYPES.SHORT_ANSWER) {
    const text = typeof answerData?.text === 'string' ? answerData.text.trim() : '';
    const answered = text.length > 0;
    if (!answered) return { answered: false, isCorrect: false, marksAwarded: 0 };
    const caseSensitive = Boolean(answerKey.case_sensitive);
    const accepted = Array.isArray(answerKey.accepted_answers) ? answerKey.accepted_answers : [];
    const candidate = caseSensitive ? text : text.toLowerCase();
    const isCorrect = accepted.some((acc) => {
      const target = String(acc).trim();
      return (caseSensitive ? target : target.toLowerCase()) === candidate;
    });
    return { answered: true, isCorrect, marksAwarded: isCorrect ? marks : -penalty };
  }

  if (qType === QUESTION_TYPES.NUMERIC) {
    const val = answerData?.value;
    const answered = typeof val === 'number' && Number.isFinite(val);
    if (!answered) return { answered: false, isCorrect: false, marksAwarded: 0 };
    const target = Number(answerKey.value);
    const tolerance = Number(answerKey.tolerance ?? 0);
    const isCorrect = Number.isFinite(target) && Math.abs(val - target) <= tolerance + 1e-9;
    return { answered: true, isCorrect, marksAwarded: isCorrect ? marks : -penalty };
  }

  if (qType === QUESTION_TYPES.MATCHING) {
    const pairs = isPlainObject(answerData?.pairs) ? answerData.pairs : null;
    const entries = pairs ? Object.entries(pairs).filter(([, v]) => v !== null && v !== '') : [];
    const answered = entries.length > 0;
    if (!answered) return { answered: false, isCorrect: false, marksAwarded: 0 };
    const expectedPairs = isPlainObject(answerKey.pairs) ? answerKey.pairs : {};
    const expectedKeys = Object.keys(expectedPairs);
    const isCorrect = expectedKeys.length > 0 &&
      entries.length === expectedKeys.length &&
      expectedKeys.every((pId) => String(pairs[pId] ?? '').toUpperCase() === String(expectedPairs[pId]).toUpperCase());
    return { answered: true, isCorrect, marksAwarded: isCorrect ? marks : -penalty };
  }

  if (qType === QUESTION_TYPES.ORDERING) {
    const order = Array.isArray(answerData?.order) ? answerData.order : [];
    const answered = order.length > 0;
    if (!answered) return { answered: false, isCorrect: false, marksAwarded: 0 };
    const expectedOrder = Array.isArray(answerKey.correct_order) ? answerKey.correct_order : [];
    const isCorrect = expectedOrder.length > 0 &&
      order.length === expectedOrder.length &&
      expectedOrder.every((id, idx) => String(order[idx] ?? '').toUpperCase() === String(id).toUpperCase());
    return { answered: true, isCorrect, marksAwarded: isCorrect ? marks : -penalty };
  }

  return { answered: false, isCorrect: false, marksAwarded: 0 };
}

export const SQLITE_QUESTIONS_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS trg_questions_sync_legacy_mcq_insert
  AFTER INSERT ON questions
  WHEN NEW.question_type = 'mcq_single' AND (NEW.question_config = '{}' OR NEW.answer_key = '{}')
  BEGIN
    UPDATE questions
    SET
      question_config = CASE
        WHEN NEW.question_config = '{}' THEN json_object(
          'options', json_array(
            json_object('id', 'A', 'text', NEW.option_a),
            json_object('id', 'B', 'text', NEW.option_b),
            json_object('id', 'C', 'text', NEW.option_c),
            json_object('id', 'D', 'text', NEW.option_d)
          )
        )
        ELSE NEW.question_config
      END,
      answer_key = CASE
        WHEN NEW.answer_key = '{}' THEN json_object('correct_option', NEW.correct_option)
        ELSE NEW.answer_key
      END
    WHERE id = NEW.id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_questions_sync_legacy_mcq_update
  AFTER UPDATE OF option_a, option_b, option_c, option_d, correct_option ON questions
  WHEN NEW.question_type = 'mcq_single'
    AND (OLD.option_a != NEW.option_a OR OLD.option_b != NEW.option_b OR OLD.option_c != NEW.option_c OR OLD.option_d != NEW.option_d OR OLD.correct_option != NEW.correct_option)
    AND NEW.question_config = OLD.question_config
    AND NEW.answer_key = OLD.answer_key
  BEGIN
    UPDATE questions
    SET
      question_config = json_object(
        'options', json_array(
          json_object('id', 'A', 'text', NEW.option_a),
          json_object('id', 'B', 'text', NEW.option_b),
          json_object('id', 'C', 'text', NEW.option_c),
          json_object('id', 'D', 'text', NEW.option_d)
        )
      ),
      answer_key = json_object('correct_option', NEW.correct_option)
    WHERE id = NEW.id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_answers_sync_legacy_insert
  AFTER INSERT ON answers
  WHEN NEW.selected_option IS NOT NULL AND NEW.answer_data IS NULL
  BEGIN
    UPDATE answers
    SET answer_data = json_object('selected_option', NEW.selected_option)
    WHERE id = NEW.id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_answers_sync_legacy_update
  AFTER UPDATE OF selected_option ON answers
  WHEN (OLD.selected_option IS NOT NEW.selected_option)
    AND (NEW.answer_data IS OLD.answer_data)
  BEGIN
    UPDATE answers
    SET answer_data = CASE
      WHEN NEW.selected_option IS NOT NULL THEN json_object('selected_option', NEW.selected_option)
      ELSE NULL
    END
    WHERE id = NEW.id;
  END;
`;

export function migrateSqliteDatabase(db) {
  function addColumnIfMissing(table, column, definition) {
    const columns = db.pragma(`table_info(${table})`);
    if (!columns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
  }

  db.transaction(() => {
    addColumnIfMissing('questions', 'archived', 'archived INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing('questions', 'explanation', "explanation TEXT NOT NULL DEFAULT ''");
    addColumnIfMissing('questions', 'question_type', "question_type TEXT NOT NULL DEFAULT 'mcq_single'");
    addColumnIfMissing('questions', 'question_config', "question_config TEXT NOT NULL DEFAULT '{}'");
    addColumnIfMissing('questions', 'answer_key', "answer_key TEXT NOT NULL DEFAULT '{}'");
    addColumnIfMissing('questions', 'media', 'media TEXT');
    addColumnIfMissing('exams', 'subject', "subject TEXT NOT NULL DEFAULT ''");
    addColumnIfMissing('exams', 'negative_mark', 'negative_mark REAL NOT NULL DEFAULT 0');
    addColumnIfMissing('exams', 'short_url', "short_url TEXT NOT NULL DEFAULT ''");
    addColumnIfMissing('exams', 'allow_pdf_download', 'allow_pdf_download INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing('attempts', 'address', "address TEXT NOT NULL DEFAULT ''");
    addColumnIfMissing('answers', 'answer_data', 'answer_data TEXT');
  })();

  // Check if questions table needs constraint upgrade (legacy table had strict CHECK (correct_option IN ('A','B','C','D')) without question_type condition)
  const tableMaster = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='questions'").get();
  const tableSql = String(tableMaster?.sql || '');
  const needsTableRebuild = !tableSql.includes('questions_type_check') && !tableSql.includes("question_type = 'mcq_single'");

  if (needsTableRebuild) {
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE __new_questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0,
            question_text TEXT NOT NULL,
            question_type TEXT NOT NULL DEFAULT 'mcq_single',
            option_a TEXT NOT NULL DEFAULT '',
            option_b TEXT NOT NULL DEFAULT '',
            option_c TEXT NOT NULL DEFAULT '',
            option_d TEXT NOT NULL DEFAULT '',
            correct_option TEXT NOT NULL DEFAULT '',
            question_config TEXT NOT NULL DEFAULT '{}',
            answer_key TEXT NOT NULL DEFAULT '{}',
            media TEXT,
            category TEXT NOT NULL DEFAULT '',
            difficulty TEXT NOT NULL DEFAULT '',
            explanation TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT questions_type_check CHECK (question_type IN ('mcq_single','mcq_multi','true_false','short_answer','numeric','matching','ordering')),
            CONSTRAINT questions_correct_option_check CHECK ((question_type = 'mcq_single' AND correct_option IN ('A','B','C','D')) OR (question_type != 'mcq_single' AND (correct_option = '' OR correct_option IN ('A','B','C','D'))))
          );
          INSERT INTO __new_questions (
            id, archived, question_text, question_type,
            option_a, option_b, option_c, option_d, correct_option,
            question_config, answer_key, media,
            category, difficulty, explanation, created_at
          )
          SELECT
            id,
            COALESCE(archived, 0),
            question_text,
            COALESCE(NULLIF(question_type, ''), 'mcq_single'),
            COALESCE(option_a, ''),
            COALESCE(option_b, ''),
            COALESCE(option_c, ''),
            COALESCE(option_d, ''),
            COALESCE(correct_option, ''),
            CASE
              WHEN question_config IS NULL OR question_config = '' OR question_config = '{}' THEN json_object(
                'options', json_array(
                  json_object('id', 'A', 'text', COALESCE(option_a, '')),
                  json_object('id', 'B', 'text', COALESCE(option_b, '')),
                  json_object('id', 'C', 'text', COALESCE(option_c, '')),
                  json_object('id', 'D', 'text', COALESCE(option_d, ''))
                )
              )
              ELSE question_config
            END,
            CASE
              WHEN answer_key IS NULL OR answer_key = '' OR answer_key = '{}' THEN json_object('correct_option', COALESCE(correct_option, ''))
              ELSE answer_key
            END,
            media,
            COALESCE(category, ''),
            COALESCE(difficulty, ''),
            COALESCE(explanation, ''),
            COALESCE(created_at, CURRENT_TIMESTAMP)
          FROM questions;
          DROP TABLE questions;
          ALTER TABLE __new_questions RENAME TO questions;
          CREATE INDEX IF NOT EXISTS idx_questions_category_difficulty ON questions(category, difficulty);
          CREATE INDEX IF NOT EXISTS idx_questions_type ON questions(question_type);
        `);
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }

  db.transaction(() => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_questions_category_difficulty ON questions(category, difficulty);
      CREATE INDEX IF NOT EXISTS idx_questions_type ON questions(question_type);
      UPDATE questions
      SET
        question_type = COALESCE(NULLIF(question_type, ''), 'mcq_single'),
        question_config = CASE
          WHEN (question_config IS NULL OR question_config = '' OR question_config = '{}') AND COALESCE(NULLIF(question_type, ''), 'mcq_single') = 'mcq_single'
          THEN json_object(
            'options', json_array(
              json_object('id', 'A', 'text', COALESCE(option_a, '')),
              json_object('id', 'B', 'text', COALESCE(option_b, '')),
              json_object('id', 'C', 'text', COALESCE(option_c, '')),
              json_object('id', 'D', 'text', COALESCE(option_d, ''))
            )
          )
          ELSE COALESCE(question_config, '{}')
        END,
        answer_key = CASE
          WHEN (answer_key IS NULL OR answer_key = '' OR answer_key = '{}') AND COALESCE(NULLIF(question_type, ''), 'mcq_single') = 'mcq_single'
          THEN json_object('correct_option', COALESCE(correct_option, ''))
          ELSE COALESCE(answer_key, '{}')
        END
      WHERE question_config IS NULL OR question_config = '' OR question_config = '{}'
         OR answer_key IS NULL OR answer_key = '' OR answer_key = '{}';

      UPDATE answers
      SET answer_data = json_object('selected_option', selected_option)
      WHERE selected_option IS NOT NULL AND (answer_data IS NULL OR answer_data = '');
    `);
    db.exec(SQLITE_QUESTIONS_TRIGGERS_SQL);
  })();
}
