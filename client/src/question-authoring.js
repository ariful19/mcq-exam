import {
  QUESTION_TYPES,
  SUPPORTED_QUESTION_TYPES,
  DEFAULT_QUESTION_TYPE,
  ALLOWED_MEDIA_TYPES,
  LEGACY_MCQ_LETTERS,
  QUESTION_TYPE_META,
  normalizeQuestion,
  validateQuestionMedia,
  hydrateQuestionRow,
  hydrateAnswerRow,
  validateStudentAnswer,
  evaluateQuestionAnswer,
} from '../../server/question-types.js';

export {
  QUESTION_TYPES,
  SUPPORTED_QUESTION_TYPES,
  DEFAULT_QUESTION_TYPE,
  ALLOWED_MEDIA_TYPES,
  LEGACY_MCQ_LETTERS,
  QUESTION_TYPE_META,
  normalizeQuestion,
  validateQuestionMedia,
  hydrateQuestionRow,
  hydrateAnswerRow,
  validateStudentAnswer,
  evaluateQuestionAnswer,
};

export const MULTI_OPTION_LETTERS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);

export const QUESTION_TYPE_OPTIONS = Object.freeze(
  SUPPORTED_QUESTION_TYPES.map((type) => ({
    value: type,
    ...QUESTION_TYPE_META[type],
  })),
);

const RELEVANT_INPUTS_BY_TYPE = Object.freeze({
  [QUESTION_TYPES.MCQ_SINGLE]: Object.freeze({
    sections: Object.freeze(['common', 'mcq_single', 'media', 'explanation']),
    inputs: Object.freeze([
      'question_type',
      'question_text',
      'option_a',
      'option_b',
      'option_c',
      'option_d',
      'correct_option',
      'category',
      'difficulty',
      'media_type',
      'explanation',
    ]),
  }),
  [QUESTION_TYPES.MCQ_MULTI]: Object.freeze({
    sections: Object.freeze(['common', 'mcq_multi', 'media', 'explanation']),
    inputs: Object.freeze([
      'question_type',
      'question_text',
      'mcq_multi_options',
      'correct_options',
      'min_selections',
      'max_selections',
      'category',
      'difficulty',
      'media_type',
      'explanation',
    ]),
  }),
  [QUESTION_TYPES.TRUE_FALSE]: Object.freeze({
    sections: Object.freeze(['common', 'true_false', 'media', 'explanation']),
    inputs: Object.freeze([
      'question_type',
      'question_text',
      'correct_answer',
      'true_text',
      'false_text',
      'category',
      'difficulty',
      'media_type',
      'explanation',
    ]),
  }),
  [QUESTION_TYPES.SHORT_ANSWER]: Object.freeze({
    sections: Object.freeze(['common', 'short_answer', 'media', 'explanation']),
    inputs: Object.freeze([
      'question_type',
      'question_text',
      'accepted_answers',
      'case_sensitive',
      'max_length',
      'placeholder',
      'category',
      'difficulty',
      'media_type',
      'explanation',
    ]),
  }),
  [QUESTION_TYPES.NUMERIC]: Object.freeze({
    sections: Object.freeze(['common', 'numeric', 'media', 'explanation']),
    inputs: Object.freeze([
      'question_type',
      'question_text',
      'numeric_value',
      'numeric_tolerance',
      'allow_decimals',
      'numeric_unit',
      'placeholder',
      'category',
      'difficulty',
      'media_type',
      'explanation',
    ]),
  }),
  [QUESTION_TYPES.MATCHING]: Object.freeze({
    sections: Object.freeze(['common', 'matching', 'media', 'explanation']),
    inputs: Object.freeze([
      'question_type',
      'question_text',
      'matching_prompts',
      'matching_choices',
      'matching_pairs',
      'category',
      'difficulty',
      'media_type',
      'explanation',
    ]),
  }),
  [QUESTION_TYPES.ORDERING]: Object.freeze({
    sections: Object.freeze(['common', 'ordering', 'media', 'explanation']),
    inputs: Object.freeze([
      'question_type',
      'question_text',
      'ordering_items',
      'correct_order',
      'category',
      'difficulty',
      'media_type',
      'explanation',
    ]),
  }),
});

export function getQuestionTypeMeta(type) {
  const key = String(type || DEFAULT_QUESTION_TYPE).trim().toLowerCase();
  return QUESTION_TYPE_META[key] || QUESTION_TYPE_META[DEFAULT_QUESTION_TYPE];
}

export function getRelevantInputsForType(type) {
  const key = String(type || DEFAULT_QUESTION_TYPE).trim().toLowerCase();
  return RELEVANT_INPUTS_BY_TYPE[key] || RELEVANT_INPUTS_BY_TYPE[DEFAULT_QUESTION_TYPE];
}

export function createDefaultTypeSlice(type) {
  switch (type) {
    case QUESTION_TYPES.MCQ_SINGLE:
      return {
        option_a: '',
        option_b: '',
        option_c: '',
        option_d: '',
        correct_option: 'A',
      };
    case QUESTION_TYPES.MCQ_MULTI:
      return {
        options: [
          { id: 'A', text: '' },
          { id: 'B', text: '' },
          { id: 'C', text: '' },
          { id: 'D', text: '' },
        ],
        correct_options: ['A'],
        min_selections: '',
        max_selections: '',
      };
    case QUESTION_TYPES.TRUE_FALSE:
      return {
        true_text: 'True',
        false_text: 'False',
        correct_answer: true,
      };
    case QUESTION_TYPES.SHORT_ANSWER:
      return {
        accepted_answers: [''],
        case_sensitive: false,
        max_length: 200,
        placeholder: '',
      };
    case QUESTION_TYPES.NUMERIC:
      return {
        value: '',
        tolerance: '0',
        allow_decimals: true,
        unit: '',
        placeholder: '',
      };
    case QUESTION_TYPES.MATCHING:
      return {
        prompts: [
          { id: 'P1', text: '' },
          { id: 'P2', text: '' },
        ],
        choices: [
          { id: 'C1', text: '' },
          { id: 'C2', text: '' },
        ],
        pairs: { P1: 'C1', P2: 'C2' },
      };
    case QUESTION_TYPES.ORDERING:
      return {
        items: [
          { id: 'I1', text: '' },
          { id: 'I2', text: '' },
          { id: 'I3', text: '' },
        ],
        correct_order: ['I1', 'I2', 'I3'],
      };
    default:
      return createDefaultTypeSlice(DEFAULT_QUESTION_TYPE);
  }
}

export function createEmptyTypeData() {
  return {
    [QUESTION_TYPES.MCQ_SINGLE]: createDefaultTypeSlice(QUESTION_TYPES.MCQ_SINGLE),
    [QUESTION_TYPES.MCQ_MULTI]: createDefaultTypeSlice(QUESTION_TYPES.MCQ_MULTI),
    [QUESTION_TYPES.TRUE_FALSE]: createDefaultTypeSlice(QUESTION_TYPES.TRUE_FALSE),
    [QUESTION_TYPES.SHORT_ANSWER]: createDefaultTypeSlice(QUESTION_TYPES.SHORT_ANSWER),
    [QUESTION_TYPES.NUMERIC]: createDefaultTypeSlice(QUESTION_TYPES.NUMERIC),
    [QUESTION_TYPES.MATCHING]: createDefaultTypeSlice(QUESTION_TYPES.MATCHING),
    [QUESTION_TYPES.ORDERING]: createDefaultTypeSlice(QUESTION_TYPES.ORDERING),
  };
}

export function createQuestionDraft(question = null) {
  const hydrated = question ? hydrateQuestionRow(question, { includeAnswerKey: true }) : null;
  const rawType = String(hydrated?.question_type || DEFAULT_QUESTION_TYPE).trim().toLowerCase();
  const questionType = SUPPORTED_QUESTION_TYPES.includes(rawType) ? rawType : DEFAULT_QUESTION_TYPE;
  const typeData = createEmptyTypeData();

  if (hydrated) {
    const qConfig = hydrated.question_config || {};
    const aKey = hydrated.answer_key || {};

    if (questionType === QUESTION_TYPES.MCQ_SINGLE) {
      const optsById = Object.fromEntries((qConfig.options || []).map((o) => [String(o.id).toUpperCase(), String(o.text ?? '')]));
      const optA = String(hydrated.option_a || optsById.A || '');
      const optB = String(hydrated.option_b || optsById.B || '');
      const optC = String(hydrated.option_c || optsById.C || '');
      const optD = String(hydrated.option_d || optsById.D || '');
      const correct = String(hydrated.correct_option || aKey.correct_option || 'A').toUpperCase();
      typeData[QUESTION_TYPES.MCQ_SINGLE] = {
        option_a: optA,
        option_b: optB,
        option_c: optC,
        option_d: optD,
        correct_option: LEGACY_MCQ_LETTERS.includes(correct) ? correct : 'A',
      };
    } else if (questionType === QUESTION_TYPES.MCQ_MULTI) {
      const rawOpts = Array.isArray(qConfig.options) && qConfig.options.length >= 2
        ? qConfig.options
        : [
            { id: 'A', text: String(hydrated.option_a ?? '') },
            { id: 'B', text: String(hydrated.option_b ?? '') },
            { id: 'C', text: String(hydrated.option_c ?? '') },
            { id: 'D', text: String(hydrated.option_d ?? '') },
          ];
      const options = rawOpts.map((opt, idx) => ({
        id: String(opt.id || MULTI_OPTION_LETTERS[idx] || `O${idx + 1}`).toUpperCase(),
        text: String(opt.text ?? ''),
      }));
      const correctOptions = Array.isArray(aKey.correct_options) && aKey.correct_options.length > 0
        ? aKey.correct_options.map((id) => String(id).toUpperCase())
        : [options[0]?.id || 'A'];
      typeData[QUESTION_TYPES.MCQ_MULTI] = {
        options,
        correct_options: correctOptions,
        min_selections: qConfig.min_selections !== undefined ? String(qConfig.min_selections) : '',
        max_selections: qConfig.max_selections !== undefined ? String(qConfig.max_selections) : '',
      };
    } else if (questionType === QUESTION_TYPES.TRUE_FALSE) {
      const opts = Array.isArray(qConfig.options) ? qConfig.options : [];
      const trueOpt = opts.find((o) => String(o.id).toLowerCase() === 'true');
      const falseOpt = opts.find((o) => String(o.id).toLowerCase() === 'false');
      typeData[QUESTION_TYPES.TRUE_FALSE] = {
        true_text: String(trueOpt?.text || hydrated.option_a || 'True'),
        false_text: String(falseOpt?.text || hydrated.option_b || 'False'),
        correct_answer: aKey.correct_answer !== undefined ? Boolean(aKey.correct_answer) : true,
      };
    } else if (questionType === QUESTION_TYPES.SHORT_ANSWER) {
      const accepted = Array.isArray(aKey.accepted_answers) && aKey.accepted_answers.length > 0
        ? aKey.accepted_answers.map((item) => String(item ?? ''))
        : [''];
      typeData[QUESTION_TYPES.SHORT_ANSWER] = {
        accepted_answers: accepted,
        case_sensitive: Boolean(aKey.case_sensitive ?? qConfig.case_sensitive ?? false),
        max_length: qConfig.max_length !== undefined ? Number(qConfig.max_length) : 200,
        placeholder: String(qConfig.placeholder ?? ''),
      };
    } else if (questionType === QUESTION_TYPES.NUMERIC) {
      typeData[QUESTION_TYPES.NUMERIC] = {
        value: aKey.value !== undefined && aKey.value !== null && !Number.isNaN(aKey.value) ? String(aKey.value) : '',
        tolerance: aKey.tolerance !== undefined && aKey.tolerance !== null ? String(aKey.tolerance) : '0',
        allow_decimals: qConfig.allow_decimals !== undefined ? Boolean(qConfig.allow_decimals) : true,
        unit: String(qConfig.unit ?? ''),
        placeholder: String(qConfig.placeholder ?? ''),
      };
    } else if (questionType === QUESTION_TYPES.MATCHING) {
      const prompts = Array.isArray(qConfig.prompts) && qConfig.prompts.length >= 2
        ? qConfig.prompts.map((p, idx) => ({ id: String(p.id || `P${idx + 1}`).toUpperCase(), text: String(p.text ?? '') }))
        : [
            { id: 'P1', text: '' },
            { id: 'P2', text: '' },
          ];
      const choices = Array.isArray(qConfig.choices) && qConfig.choices.length >= 2
        ? qConfig.choices.map((c, idx) => ({ id: String(c.id || `C${idx + 1}`).toUpperCase(), text: String(c.text ?? '') }))
        : [
            { id: 'C1', text: '' },
            { id: 'C2', text: '' },
          ];
      const rawPairs = aKey.pairs && typeof aKey.pairs === 'object' ? aKey.pairs : {};
      const pairs = {};
      prompts.forEach((p, idx) => {
        const mapped = rawPairs[p.id] ?? rawPairs[p.id.toLowerCase()] ?? choices[Math.min(idx, choices.length - 1)]?.id ?? 'C1';
        pairs[p.id] = String(mapped).toUpperCase();
      });
      typeData[QUESTION_TYPES.MATCHING] = { prompts, choices, pairs };
    } else if (questionType === QUESTION_TYPES.ORDERING) {
      const items = Array.isArray(qConfig.items) && qConfig.items.length >= 2
        ? qConfig.items.map((item, idx) => ({ id: String(item.id || `I${idx + 1}`).toUpperCase(), text: String(item.text ?? '') }))
        : [
            { id: 'I1', text: '' },
            { id: 'I2', text: '' },
            { id: 'I3', text: '' },
          ];
      const itemMap = new Map(items.map((item) => [item.id, item]));
      const rawOrder = Array.isArray(aKey.correct_order) && aKey.correct_order.length === items.length
        ? aKey.correct_order.map((id) => String(id).toUpperCase()).filter((id) => itemMap.has(id))
        : items.map((item) => item.id);
      const finalOrder = rawOrder.length === items.length ? rawOrder : items.map((item) => item.id);
      typeData[QUESTION_TYPES.ORDERING] = {
        items,
        correct_order: finalOrder,
      };
    }
  }

  const mediaObj = hydrated?.media && typeof hydrated.media === 'object' ? hydrated.media : null;

  return {
    id: hydrated?.id ?? null,
    locked: Boolean(hydrated?.locked),
    question_type: questionType,
    question_text: String(hydrated?.question_text ?? ''),
    category: String(hydrated?.category ?? ''),
    difficulty: String(hydrated?.difficulty ?? ''),
    explanation: String(hydrated?.explanation ?? ''),
    media: {
      enabled: Boolean(mediaObj?.type && mediaObj?.url),
      type: ALLOWED_MEDIA_TYPES.includes(mediaObj?.type) ? mediaObj.type : 'image',
      url: String(mediaObj?.url ?? ''),
      alt: String(mediaObj?.alt ?? ''),
      caption: String(mediaObj?.caption ?? ''),
    },
    typeData,
    pendingTypeSwitch: null,
    lastSwitchNotice: null,
  };
}

export function hasPopulatedTypeData(draft, type = draft?.question_type) {
  if (!draft?.typeData?.[type]) return false;
  const td = draft.typeData[type];
  switch (type) {
    case QUESTION_TYPES.MCQ_SINGLE:
      return Boolean(
        td.option_a?.trim() ||
        td.option_b?.trim() ||
        td.option_c?.trim() ||
        td.option_d?.trim()
      );
    case QUESTION_TYPES.MCQ_MULTI:
      return Boolean(
        (td.options || []).some((o) => o.text?.trim()) ||
        String(td.min_selections ?? '').trim() !== '' ||
        String(td.max_selections ?? '').trim() !== ''
      );
    case QUESTION_TYPES.TRUE_FALSE:
      return Boolean(
        (td.true_text?.trim() && td.true_text.trim() !== 'True') ||
        (td.false_text?.trim() && td.false_text.trim() !== 'False')
      );
    case QUESTION_TYPES.SHORT_ANSWER:
      return Boolean(
        (td.accepted_answers || []).some((a) => String(a ?? '').trim()) ||
        td.case_sensitive === true ||
        (Number(td.max_length) && Number(td.max_length) !== 200) ||
        td.placeholder?.trim()
      );
    case QUESTION_TYPES.NUMERIC:
      return Boolean(
        String(td.value ?? '').trim() !== '' ||
        (String(td.tolerance ?? '').trim() !== '' && Number(td.tolerance) !== 0) ||
        td.allow_decimals === false ||
        td.unit?.trim() ||
        td.placeholder?.trim()
      );
    case QUESTION_TYPES.MATCHING:
      return Boolean(
        (td.prompts || []).some((p) => p.text?.trim()) ||
        (td.choices || []).some((c) => c.text?.trim())
      );
    case QUESTION_TYPES.ORDERING:
      return Boolean((td.items || []).some((i) => i.text?.trim()));
    default:
      return false;
  }
}

export function getIncompatibleFieldsOnTypeSwitch(draft, fromType, toType) {
  if (!draft || !fromType || !toType || fromType === toType) return [];
  const td = draft.typeData?.[fromType];
  if (!td || !hasPopulatedTypeData(draft, fromType)) return [];

  const incompatible = [];

  if (fromType === QUESTION_TYPES.MCQ_SINGLE) {
    if (toType === QUESTION_TYPES.MCQ_MULTI) {
      return [];
    }
    if (td.option_a?.trim() || td.option_b?.trim() || td.option_c?.trim() || td.option_d?.trim()) {
      incompatible.push('MCQ options (A–D) and single-choice answer key');
    }
  } else if (fromType === QUESTION_TYPES.MCQ_MULTI) {
    if (toType === QUESTION_TYPES.MCQ_SINGLE) {
      const extraPopulated = (td.options || []).slice(4).some((o) => o.text?.trim());
      if (extraPopulated) incompatible.push('Extra options beyond Option D');
      if ((td.correct_options || []).length > 1) incompatible.push('Multiple correct option selections');
      if (String(td.min_selections ?? '').trim() || String(td.max_selections ?? '').trim()) {
        incompatible.push('Minimum/maximum selection limits');
      }
    } else {
      if ((td.options || []).some((o) => o.text?.trim())) {
        incompatible.push('Multiple-select options and answer key');
      }
      if (String(td.min_selections ?? '').trim() || String(td.max_selections ?? '').trim()) {
        incompatible.push('Minimum/maximum selection limits');
      }
    }
  } else if (fromType === QUESTION_TYPES.TRUE_FALSE) {
    if (
      (td.true_text?.trim() && td.true_text.trim() !== 'True') ||
      (td.false_text?.trim() && td.false_text.trim() !== 'False')
    ) {
      incompatible.push('Custom True/False option labels');
    }
  } else if (fromType === QUESTION_TYPES.SHORT_ANSWER) {
    const populatedAnswers = (td.accepted_answers || []).map((a) => String(a ?? '').trim()).filter(Boolean);
    if (toType === QUESTION_TYPES.NUMERIC) {
      const firstIsNumeric = populatedAnswers.length === 1 && Number.isFinite(Number(populatedAnswers[0]));
      if (populatedAnswers.length > 0 && !firstIsNumeric) {
        incompatible.push('Accepted text answers');
      }
      if (td.case_sensitive) incompatible.push('Case-sensitive text matching');
      if (Number(td.max_length) && Number(td.max_length) !== 200) incompatible.push('Maximum character length');
    } else {
      if (populatedAnswers.length > 0) incompatible.push('Accepted short answers');
      if (td.case_sensitive) incompatible.push('Case-sensitive text matching');
      if (td.placeholder?.trim()) incompatible.push('Short answer placeholder');
    }
  } else if (fromType === QUESTION_TYPES.NUMERIC) {
    if (toType === QUESTION_TYPES.SHORT_ANSWER) {
      if (String(td.tolerance ?? '').trim() !== '' && Number(td.tolerance) > 0) {
        incompatible.push('Numeric tolerance (±)');
      }
      if (td.unit?.trim()) incompatible.push('Numeric unit');
      if (td.allow_decimals === false) incompatible.push('Whole-number-only constraint');
    } else {
      if (String(td.value ?? '').trim() !== '') incompatible.push('Numeric answer value');
      if (String(td.tolerance ?? '').trim() !== '' && Number(td.tolerance) > 0) incompatible.push('Numeric tolerance (±)');
      if (td.unit?.trim()) incompatible.push('Numeric unit');
    }
  } else if (fromType === QUESTION_TYPES.MATCHING) {
    if ((td.prompts || []).some((p) => p.text?.trim()) || (td.choices || []).some((c) => c.text?.trim())) {
      incompatible.push('Matching prompts, choices, and answer pairs');
    }
  } else if (fromType === QUESTION_TYPES.ORDERING) {
    if ((td.items || []).some((i) => i.text?.trim())) {
      incompatible.push('Ordering sequence items and order key');
    }
  }

  return incompatible;
}

function migrateCompatibleTypeFields(draft, fromType, toType) {
  if (!draft?.typeData || fromType === toType) return;
  const src = draft.typeData[fromType];
  const dst = draft.typeData[toType];
  if (!src || !dst) return;

  if (fromType === QUESTION_TYPES.MCQ_SINGLE && toType === QUESTION_TYPES.MCQ_MULTI) {
    const dstEmpty = !hasPopulatedTypeData(draft, QUESTION_TYPES.MCQ_MULTI);
    if (dstEmpty && hasPopulatedTypeData(draft, QUESTION_TYPES.MCQ_SINGLE)) {
      dst.options = [
        { id: 'A', text: src.option_a || '' },
        { id: 'B', text: src.option_b || '' },
        { id: 'C', text: src.option_c || '' },
        { id: 'D', text: src.option_d || '' },
      ];
      dst.correct_options = [src.correct_option || 'A'];
    }
  }

  if (fromType === QUESTION_TYPES.MCQ_MULTI && toType === QUESTION_TYPES.MCQ_SINGLE) {
    const dstEmpty = !hasPopulatedTypeData(draft, QUESTION_TYPES.MCQ_SINGLE);
    if (dstEmpty && hasPopulatedTypeData(draft, QUESTION_TYPES.MCQ_MULTI)) {
      const byId = Object.fromEntries((src.options || []).map((o) => [o.id, o.text]));
      dst.option_a = byId.A ?? src.options?.[0]?.text ?? '';
      dst.option_b = byId.B ?? src.options?.[1]?.text ?? '';
      dst.option_c = byId.C ?? src.options?.[2]?.text ?? '';
      dst.option_d = byId.D ?? src.options?.[3]?.text ?? '';
      const firstValid = (src.correct_options || []).find((id) => LEGACY_MCQ_LETTERS.includes(id));
      dst.correct_option = firstValid || 'A';
    }
  }

  if (fromType === QUESTION_TYPES.SHORT_ANSWER && toType === QUESTION_TYPES.NUMERIC) {
    const dstEmpty = !hasPopulatedTypeData(draft, QUESTION_TYPES.NUMERIC);
    if (dstEmpty) {
      const firstAns = String(src.accepted_answers?.[0] ?? '').trim();
      if (firstAns !== '' && Number.isFinite(Number(firstAns))) {
        dst.value = firstAns;
      }
      if (src.placeholder && !dst.placeholder) {
        dst.placeholder = src.placeholder;
      }
    }
  }

  if (fromType === QUESTION_TYPES.NUMERIC && toType === QUESTION_TYPES.SHORT_ANSWER) {
    const dstEmpty = !hasPopulatedTypeData(draft, QUESTION_TYPES.SHORT_ANSWER);
    if (dstEmpty) {
      const valStr = String(src.value ?? '').trim();
      if (valStr !== '') {
        dst.accepted_answers = [valStr];
      }
      if (src.placeholder && !dst.placeholder) {
        dst.placeholder = src.placeholder;
      }
    }
  }
}

export function switchQuestionDraftType(draft, nextType, options = {}) {
  if (!draft) return { switched: false, requiresConfirmation: false, incompatibleFields: [], draft };
  const targetType = String(nextType || DEFAULT_QUESTION_TYPE).trim().toLowerCase();
  if (!SUPPORTED_QUESTION_TYPES.includes(targetType)) {
    return { switched: false, requiresConfirmation: false, incompatibleFields: [], draft };
  }
  const fromType = draft.question_type || DEFAULT_QUESTION_TYPE;
  if (fromType === targetType) {
    draft.pendingTypeSwitch = null;
    return { switched: true, requiresConfirmation: false, incompatibleFields: [], draft };
  }

  const incompatibleFields = getIncompatibleFieldsOnTypeSwitch(draft, fromType, targetType);

  if (options.askBeforeDiscard && incompatibleFields.length > 0 && !options.confirmed) {
    draft.pendingTypeSwitch = {
      fromType,
      toType: targetType,
      incompatibleFields,
    };
    return {
      switched: false,
      requiresConfirmation: true,
      incompatibleFields,
      draft,
    };
  }

  migrateCompatibleTypeFields(draft, fromType, targetType);

  if (options.discardIncompatible && incompatibleFields.length > 0) {
    draft.typeData[fromType] = createDefaultTypeSlice(fromType);
    draft.lastSwitchNotice = null;
  } else if (incompatibleFields.length > 0) {
    draft.lastSwitchNotice = {
      fromType,
      toType: targetType,
      incompatibleFields,
    };
  } else {
    draft.lastSwitchNotice = null;
  }

  draft.question_type = targetType;
  draft.pendingTypeSwitch = null;

  return {
    switched: true,
    requiresConfirmation: false,
    incompatibleFields,
    draft,
  };
}

export function confirmPendingTypeSwitch(draft, { discardIncompatible = true } = {}) {
  if (!draft?.pendingTypeSwitch) return draft;
  const { toType } = draft.pendingTypeSwitch;
  switchQuestionDraftType(draft, toType, {
    confirmed: true,
    discardIncompatible,
  });
  return draft;
}

export function cancelPendingTypeSwitch(draft) {
  if (!draft) return draft;
  draft.pendingTypeSwitch = null;
  return draft;
}

export function discardPreservedTypeData(draft, typeToDiscard = draft?.lastSwitchNotice?.fromType) {
  if (!draft || !typeToDiscard || !draft.typeData?.[typeToDiscard]) return draft;
  draft.typeData[typeToDiscard] = createDefaultTypeSlice(typeToDiscard);
  if (draft.lastSwitchNotice?.fromType === typeToDiscard) {
    draft.lastSwitchNotice = null;
  }
  return draft;
}

export function revertTypeSwitch(draft) {
  if (!draft?.lastSwitchNotice?.fromType) return draft;
  const previousType = draft.lastSwitchNotice.fromType;
  draft.question_type = previousType;
  draft.lastSwitchNotice = null;
  draft.pendingTypeSwitch = null;
  return draft;
}

export function addMcqMultiOption(draft) {
  const td = draft?.typeData?.[QUESTION_TYPES.MCQ_MULTI];
  if (!td || td.options.length >= 8) return draft;
  const used = new Set(td.options.map((o) => o.id));
  const nextId = MULTI_OPTION_LETTERS.find((letter) => !used.has(letter)) || `O${td.options.length + 1}`;
  td.options = [...td.options, { id: nextId, text: '' }];
  return draft;
}

export function removeMcqMultiOption(draft, index) {
  const td = draft?.typeData?.[QUESTION_TYPES.MCQ_MULTI];
  if (!td || td.options.length <= 2) return draft;
  const nextOpts = td.options.filter((_, idx) => idx !== index).map((opt, idx) => ({
    id: MULTI_OPTION_LETTERS[idx] || opt.id,
    text: opt.text,
  }));
  const idMap = new Map(td.options.map((opt, idx) => {
    if (idx === index) return [opt.id, null];
    const newIdx = idx < index ? idx : idx - 1;
    return [opt.id, MULTI_OPTION_LETTERS[newIdx] || opt.id];
  }));
  td.options = nextOpts;
  td.correct_options = (td.correct_options || [])
    .map((id) => idMap.get(id))
    .filter(Boolean);
  return draft;
}

export function toggleMcqMultiCorrectOption(draft, optionId, checked) {
  const td = draft?.typeData?.[QUESTION_TYPES.MCQ_MULTI];
  if (!td) return draft;
  const id = String(optionId).toUpperCase();
  const set = new Set(td.correct_options || []);
  if (checked) set.add(id);
  else set.delete(id);
  const validOrder = td.options.map((o) => o.id).filter((oId) => set.has(oId));
  td.correct_options = validOrder;
  return draft;
}

export function addShortAnswerAccepted(draft) {
  const td = draft?.typeData?.[QUESTION_TYPES.SHORT_ANSWER];
  if (!td || td.accepted_answers.length >= 25) return draft;
  td.accepted_answers = [...td.accepted_answers, ''];
  return draft;
}

export function removeShortAnswerAccepted(draft, index) {
  const td = draft?.typeData?.[QUESTION_TYPES.SHORT_ANSWER];
  if (!td || td.accepted_answers.length <= 1) return draft;
  td.accepted_answers = td.accepted_answers.filter((_, idx) => idx !== index);
  return draft;
}

export function addMatchingPrompt(draft) {
  const td = draft?.typeData?.[QUESTION_TYPES.MATCHING];
  if (!td || td.prompts.length >= 10) return draft;
  const nextIndex = td.prompts.length + 1;
  const nextPromptId = `P${nextIndex}`;
  td.prompts = [...td.prompts, { id: nextPromptId, text: '' }];
  if (td.choices.length < td.prompts.length && td.choices.length < 12) {
    const nextChoiceId = `C${td.choices.length + 1}`;
    td.choices = [...td.choices, { id: nextChoiceId, text: '' }];
    td.pairs = { ...td.pairs, [nextPromptId]: nextChoiceId };
  } else {
    td.pairs = { ...td.pairs, [nextPromptId]: td.choices[0]?.id || 'C1' };
  }
  return draft;
}

export function removeMatchingPrompt(draft, index) {
  const td = draft?.typeData?.[QUESTION_TYPES.MATCHING];
  if (!td || td.prompts.length <= 2) return draft;
  const remaining = td.prompts.filter((_, idx) => idx !== index);
  const nextPairs = {};
  const nextPrompts = remaining.map((prompt, idx) => {
    const newId = `P${idx + 1}`;
    nextPairs[newId] = td.pairs?.[prompt.id] || td.choices[0]?.id || 'C1';
    return { id: newId, text: prompt.text };
  });
  td.prompts = nextPrompts;
  td.pairs = nextPairs;
  return draft;
}

export function addMatchingChoice(draft) {
  const td = draft?.typeData?.[QUESTION_TYPES.MATCHING];
  if (!td || td.choices.length >= 12) return draft;
  const nextChoiceId = `C${td.choices.length + 1}`;
  td.choices = [...td.choices, { id: nextChoiceId, text: '' }];
  return draft;
}

export function removeMatchingChoice(draft, index) {
  const td = draft?.typeData?.[QUESTION_TYPES.MATCHING];
  if (!td || td.choices.length <= Math.max(2, td.prompts.length)) return draft;
  const remaining = td.choices.filter((_, idx) => idx !== index);
  const idRemap = new Map();
  const nextChoices = remaining.map((choice, idx) => {
    const newId = `C${idx + 1}`;
    idRemap.set(choice.id, newId);
    return { id: newId, text: choice.text };
  });
  const fallbackChoiceId = nextChoices[0]?.id || 'C1';
  const nextPairs = {};
  for (const prompt of td.prompts) {
    const prevChoice = td.pairs?.[prompt.id];
    nextPairs[prompt.id] = idRemap.get(prevChoice) || fallbackChoiceId;
  }
  td.choices = nextChoices;
  td.pairs = nextPairs;
  return draft;
}

export function addOrderingItem(draft) {
  const td = draft?.typeData?.[QUESTION_TYPES.ORDERING];
  if (!td || td.items.length >= 10) return draft;
  const nextId = `I${td.items.length + 1}`;
  td.items = [...td.items, { id: nextId, text: '' }];
  td.correct_order = [...(td.correct_order || []), nextId];
  return draft;
}

export function removeOrderingItem(draft, index) {
  const td = draft?.typeData?.[QUESTION_TYPES.ORDERING];
  if (!td || td.items.length <= 2) return draft;
  const orderedIds = td.correct_order?.length === td.items.length
    ? td.correct_order
    : td.items.map((i) => i.id);
  const itemById = new Map(td.items.map((item) => [item.id, item]));
  const orderedItems = orderedIds.map((id) => itemById.get(id)).filter(Boolean);
  const remaining = orderedItems.filter((_, idx) => idx !== index).map((item, idx) => ({
    id: `I${idx + 1}`,
    text: item.text,
  }));
  td.items = remaining;
  td.correct_order = remaining.map((item) => item.id);
  return draft;
}

export function moveOrderingItem(draft, index, direction) {
  const td = draft?.typeData?.[QUESTION_TYPES.ORDERING];
  if (!td) return draft;
  const targetIndex = index + direction;
  const orderedIds = td.correct_order?.length === td.items.length
    ? [...td.correct_order]
    : td.items.map((i) => i.id);
  if (index < 0 || index >= orderedIds.length || targetIndex < 0 || targetIndex >= orderedIds.length) {
    return draft;
  }
  [orderedIds[index], orderedIds[targetIndex]] = [orderedIds[targetIndex], orderedIds[index]];
  td.correct_order = orderedIds;
  return draft;
}

export function buildQuestionPayloadFromDraft(draft) {
  if (!draft) return {};
  const qType = draft.question_type || DEFAULT_QUESTION_TYPE;
  const td = draft.typeData?.[qType] || createDefaultTypeSlice(qType);

  let media = null;
  if (draft.media?.enabled) {
    media = {
      type: String(draft.media.type || 'image').trim().toLowerCase(),
      url: String(draft.media.url ?? '').trim(),
      ...(String(draft.media.alt ?? '').trim() ? { alt: String(draft.media.alt).trim() } : {}),
      ...(String(draft.media.caption ?? '').trim() ? { caption: String(draft.media.caption).trim() } : {}),
    };
  }

  const base = {
    question_type: qType,
    question_text: String(draft.question_text ?? '').trim(),
    category: String(draft.category ?? '').trim(),
    difficulty: String(draft.difficulty ?? '').trim(),
    explanation: String(draft.explanation ?? '').trim(),
    media,
  };

  if (qType === QUESTION_TYPES.MCQ_SINGLE) {
    const optA = String(td.option_a ?? '').trim();
    const optB = String(td.option_b ?? '').trim();
    const optC = String(td.option_c ?? '').trim();
    const optD = String(td.option_d ?? '').trim();
    const correctOption = String(td.correct_option || 'A').trim().toUpperCase();
    return {
      ...base,
      option_a: optA,
      option_b: optB,
      option_c: optC,
      option_d: optD,
      correct_option: correctOption,
      question_config: {
        options: [
          { id: 'A', text: optA },
          { id: 'B', text: optB },
          { id: 'C', text: optC },
          { id: 'D', text: optD },
        ],
      },
      answer_key: { correct_option: correctOption },
    };
  }

  if (qType === QUESTION_TYPES.MCQ_MULTI) {
    const options = (td.options || []).map((opt, idx) => ({
      id: String(opt.id || MULTI_OPTION_LETTERS[idx] || `O${idx + 1}`).trim().toUpperCase(),
      text: String(opt.text ?? '').trim(),
    }));
    const minSel = String(td.min_selections ?? '').trim();
    const maxSel = String(td.max_selections ?? '').trim();
    return {
      ...base,
      question_config: {
        options,
        ...(minSel !== '' ? { min_selections: Number(minSel) } : {}),
        ...(maxSel !== '' ? { max_selections: Number(maxSel) } : {}),
      },
      answer_key: {
        correct_options: (td.correct_options || []).map((id) => String(id).trim().toUpperCase()),
      },
    };
  }

  if (qType === QUESTION_TYPES.TRUE_FALSE) {
    const trueText = String(td.true_text ?? 'True').trim() || 'True';
    const falseText = String(td.false_text ?? 'False').trim() || 'False';
    const correctAns = td.correct_answer === true || String(td.correct_answer).toLowerCase() === 'true';
    return {
      ...base,
      question_config: {
        options: [
          { id: 'true', text: trueText },
          { id: 'false', text: falseText },
        ],
      },
      answer_key: {
        correct_answer: correctAns,
      },
    };
  }

  if (qType === QUESTION_TYPES.SHORT_ANSWER) {
    const rawList = Array.isArray(td.accepted_answers) ? td.accepted_answers : [];
    const cleanedList = rawList.map((a) => String(a ?? '').trim()).filter(Boolean);
    const caseSensitive = Boolean(td.case_sensitive);
    const maxLengthRaw = String(td.max_length ?? '200').trim();
    const maxLength = maxLengthRaw !== '' ? Number(maxLengthRaw) : 200;
    const placeholder = String(td.placeholder ?? '').trim();
    return {
      ...base,
      question_config: {
        case_sensitive: caseSensitive,
        max_length: maxLength,
        ...(placeholder ? { placeholder } : {}),
      },
      answer_key: {
        accepted_answers: cleanedList,
        case_sensitive: caseSensitive,
      },
    };
  }

  if (qType === QUESTION_TYPES.NUMERIC) {
    const valStr = String(td.value ?? '').trim();
    const tolStr = String(td.tolerance ?? '0').trim();
    const allowDecimals = Boolean(td.allow_decimals);
    const unit = String(td.unit ?? '').trim();
    const placeholder = String(td.placeholder ?? '').trim();
    return {
      ...base,
      question_config: {
        allow_decimals: allowDecimals,
        ...(unit ? { unit } : {}),
        ...(placeholder ? { placeholder } : {}),
      },
      answer_key: {
        value: valStr === '' ? NaN : Number(valStr),
        tolerance: tolStr === '' ? 0 : Number(tolStr),
      },
    };
  }

  if (qType === QUESTION_TYPES.MATCHING) {
    const prompts = (td.prompts || []).map((p, idx) => ({
      id: String(p.id || `P${idx + 1}`).trim().toUpperCase(),
      text: String(p.text ?? '').trim(),
    }));
    const choices = (td.choices || []).map((c, idx) => ({
      id: String(c.id || `C${idx + 1}`).trim().toUpperCase(),
      text: String(c.text ?? '').trim(),
    }));
    const pairs = {};
    for (const p of prompts) {
      const mapped = String(td.pairs?.[p.id] ?? '').trim().toUpperCase();
      if (mapped) pairs[p.id] = mapped;
    }
    return {
      ...base,
      question_config: { prompts, choices },
      answer_key: { pairs },
    };
  }

  if (qType === QUESTION_TYPES.ORDERING) {
    const items = (td.items || []).map((item, idx) => ({
      id: String(item.id || `I${idx + 1}`).trim().toUpperCase(),
      text: String(item.text ?? '').trim(),
    }));
    const correctOrder = (td.correct_order?.length === items.length ? td.correct_order : items.map((i) => i.id))
      .map((id) => String(id).trim().toUpperCase());
    return {
      ...base,
      question_config: { items },
      answer_key: { correct_order: correctOrder },
    };
  }

  return base;
}

export function validateQuestionDraft(draft) {
  const payload = buildQuestionPayloadFromDraft(draft);
  const { question, errors } = normalizeQuestion(payload);
  return {
    valid: errors.length === 0,
    errors,
    payload,
    question,
  };
}

export function formatQuestionTypeBadge(questionOrType) {
  const rawType = typeof questionOrType === 'string'
    ? questionOrType
    : questionOrType?.question_type || DEFAULT_QUESTION_TYPE;
  return getQuestionTypeMeta(rawType);
}

export function formatAnswerKeySummary(questionRow) {
  if (!questionRow) return '—';
  const q = questionRow.question_config && typeof questionRow.question_config === 'object'
    ? questionRow
    : hydrateQuestionRow(questionRow, { includeAnswerKey: true });
  const qType = q.question_type || DEFAULT_QUESTION_TYPE;
  const qConfig = q.question_config || {};
  const aKey = q.answer_key || {};

  if (qType === QUESTION_TYPES.MCQ_SINGLE) {
    return q.correct_option || aKey.correct_option || '—';
  }
  if (qType === QUESTION_TYPES.MCQ_MULTI) {
    const opts = Array.isArray(aKey.correct_options) ? aKey.correct_options : [];
    return opts.length ? opts.join(', ') : '—';
  }
  if (qType === QUESTION_TYPES.TRUE_FALSE) {
    if (typeof aKey.correct_answer === 'boolean') {
      return aKey.correct_answer ? 'True' : 'False';
    }
    return '—';
  }
  if (qType === QUESTION_TYPES.SHORT_ANSWER) {
    const accepted = Array.isArray(aKey.accepted_answers) ? aKey.accepted_answers : [];
    if (!accepted.length) return '—';
    return accepted.length === 1 ? accepted[0] : `${accepted[0]} (+${accepted.length - 1})`;
  }
  if (qType === QUESTION_TYPES.NUMERIC) {
    if (aKey.value === undefined || aKey.value === null || Number.isNaN(Number(aKey.value))) return '—';
    const tol = Number(aKey.tolerance || 0);
    const unit = qConfig.unit ? ` ${qConfig.unit}` : '';
    return tol > 0 ? `${aKey.value} ±${tol}${unit}` : `${aKey.value}${unit}`;
  }
  if (qType === QUESTION_TYPES.MATCHING) {
    const pairs = aKey.pairs && typeof aKey.pairs === 'object' ? Object.entries(aKey.pairs) : [];
    if (!pairs.length) return '—';
    return pairs.map(([p, c]) => `${p}→${c}`).join(', ');
  }
  if (qType === QUESTION_TYPES.ORDERING) {
    const order = Array.isArray(aKey.correct_order) ? aKey.correct_order : [];
    return order.length ? order.join(' → ') : '—';
  }
  return '—';
}

export function buildQuestionPreviewModel(questionOrDraft) {
  if (!questionOrDraft) return null;
  const isDraft = Boolean(questionOrDraft.typeData);
  const source = isDraft
    ? hydrateQuestionRow({
        id: questionOrDraft.id,
        locked: questionOrDraft.locked,
        ...buildQuestionPayloadFromDraft(questionOrDraft),
      }, { includeAnswerKey: true })
    : (questionOrDraft.question_config && typeof questionOrDraft.question_config === 'object'
        ? questionOrDraft
        : hydrateQuestionRow(questionOrDraft, { includeAnswerKey: true }));

  const qType = source.question_type || DEFAULT_QUESTION_TYPE;
  const meta = getQuestionTypeMeta(qType);
  const qConfig = source.question_config || {};
  const aKey = source.answer_key || {};
  const media = source.media && typeof source.media === 'object' && source.media.url ? source.media : null;

  let details = {};
  if (qType === QUESTION_TYPES.MCQ_SINGLE) {
    const correctId = String(source.correct_option || aKey.correct_option || 'A').toUpperCase();
    const rawOpts = Array.isArray(qConfig.options) && qConfig.options.length === 4
      ? qConfig.options
      : [
          { id: 'A', text: source.option_a || '' },
          { id: 'B', text: source.option_b || '' },
          { id: 'C', text: source.option_c || '' },
          { id: 'D', text: source.option_d || '' },
        ];
    details = {
      options: rawOpts.map((opt) => ({
        id: opt.id,
        text: opt.text || '',
        isCorrect: opt.id === correctId,
      })),
      correct_option: correctId,
    };
  } else if (qType === QUESTION_TYPES.MCQ_MULTI) {
    const correctSet = new Set((aKey.correct_options || []).map((id) => String(id).toUpperCase()));
    details = {
      options: (qConfig.options || []).map((opt) => ({
        id: opt.id,
        text: opt.text || '',
        isCorrect: correctSet.has(String(opt.id).toUpperCase()),
      })),
      correct_options: [...correctSet],
      min_selections: qConfig.min_selections ?? null,
      max_selections: qConfig.max_selections ?? null,
    };
  } else if (qType === QUESTION_TYPES.TRUE_FALSE) {
    const correctBool = Boolean(aKey.correct_answer);
    const opts = Array.isArray(qConfig.options) && qConfig.options.length === 2
      ? qConfig.options
      : [
          { id: 'true', text: 'True' },
          { id: 'false', text: 'False' },
        ];
    details = {
      options: opts.map((opt) => ({
        id: opt.id,
        text: opt.text || (opt.id === 'true' ? 'True' : 'False'),
        isCorrect: (opt.id === 'true' && correctBool) || (opt.id === 'false' && !correctBool),
      })),
      correct_answer: correctBool,
    };
  } else if (qType === QUESTION_TYPES.SHORT_ANSWER) {
    details = {
      accepted_answers: Array.isArray(aKey.accepted_answers) ? aKey.accepted_answers : [],
      case_sensitive: Boolean(aKey.case_sensitive ?? qConfig.case_sensitive),
      max_length: Number(qConfig.max_length || 200),
      placeholder: qConfig.placeholder || 'Type your answer…',
    };
  } else if (qType === QUESTION_TYPES.NUMERIC) {
    details = {
      value: aKey.value,
      tolerance: Number(aKey.tolerance ?? 0),
      allow_decimals: qConfig.allow_decimals !== false,
      unit: qConfig.unit || '',
      placeholder: qConfig.placeholder || 'Enter a numeric value…',
    };
  } else if (qType === QUESTION_TYPES.MATCHING) {
    const prompts = Array.isArray(qConfig.prompts) ? qConfig.prompts : [];
    const choices = Array.isArray(qConfig.choices) ? qConfig.choices : [];
    const choiceMap = new Map(choices.map((c) => [String(c.id).toUpperCase(), c.text]));
    const pairs = aKey.pairs && typeof aKey.pairs === 'object' ? aKey.pairs : {};
    details = {
      prompts: prompts.map((p) => {
        const matchedId = String(pairs[p.id] ?? '').toUpperCase();
        return {
          id: p.id,
          text: p.text || '',
          matchedChoiceId: matchedId,
          matchedChoiceText: choiceMap.get(matchedId) || '',
        };
      }),
      choices,
      pairs,
    };
  } else if (qType === QUESTION_TYPES.ORDERING) {
    const items = Array.isArray(qConfig.items) ? qConfig.items : [];
    const itemMap = new Map(items.map((item) => [String(item.id).toUpperCase(), item]));
    const orderIds = Array.isArray(aKey.correct_order) && aKey.correct_order.length
      ? aKey.correct_order
      : items.map((i) => i.id);
    details = {
      items,
      correct_order: orderIds,
      orderedItems: orderIds.map((id, idx) => {
        const item = itemMap.get(String(id).toUpperCase()) || { id, text: '' };
        return {
          position: idx + 1,
          id: item.id,
          text: item.text || '',
        };
      }),
    };
  }

  return {
    id: source.id ?? null,
    locked: Boolean(source.locked),
    question_type: qType,
    typeLabel: meta.label,
    typeShortLabel: meta.shortLabel,
    typeDescription: meta.description,
    question_text: source.question_text || '',
    category: source.category || '',
    difficulty: source.difficulty || '',
    explanation: source.explanation || '',
    media,
    answerKeySummary: formatAnswerKeySummary(source),
    details,
  };
}

export function isAnswerProvided(questionRow, selectedOption, answerData) {
  const qType = String(questionRow?.question_type || DEFAULT_QUESTION_TYPE).trim().toLowerCase();
  if (qType === QUESTION_TYPES.MCQ_SINGLE) {
    return Boolean(selectedOption || answerData?.selected_option);
  }
  if (qType === QUESTION_TYPES.MCQ_MULTI) {
    return Array.isArray(answerData?.selected_options) && answerData.selected_options.length > 0;
  }
  if (qType === QUESTION_TYPES.TRUE_FALSE) {
    return typeof answerData?.selected_answer === 'boolean';
  }
  if (qType === QUESTION_TYPES.SHORT_ANSWER) {
    return typeof answerData?.text === 'string' && answerData.text.trim().length > 0;
  }
  if (qType === QUESTION_TYPES.NUMERIC) {
    return typeof answerData?.value === 'number' && Number.isFinite(answerData.value);
  }
  if (qType === QUESTION_TYPES.MATCHING) {
    const pairs = answerData?.pairs;
    return Boolean(pairs && typeof pairs === 'object' && Object.values(pairs).some((v) => v !== null && v !== ''));
  }
  if (qType === QUESTION_TYPES.ORDERING) {
    return Array.isArray(answerData?.order) && answerData.order.length > 0;
  }
  return Boolean(selectedOption);
}

export function formatStudentAnswerSummary(answerRow) {
  if (!answerRow) return 'Not answered';
  const q = answerRow.question_config && typeof answerRow.question_config === 'object'
    ? answerRow
    : hydrateAnswerRow(answerRow);
  const qType = q.question_type || DEFAULT_QUESTION_TYPE;
  const qConfig = q.question_config || {};
  const data = q.answer_data || {};

  if (qType === QUESTION_TYPES.MCQ_SINGLE) {
    const sel = q.selected_option || data.selected_option;
    if (!sel) return 'Not answered';
    const optMap = { A: q.option_a, B: q.option_b, C: q.option_c, D: q.option_d };
    const text = optMap[sel] ?? (qConfig.options || []).find((o) => o.id === sel)?.text ?? '';
    return text ? `${sel}. ${text}` : `Option ${sel}`;
  }
  if (qType === QUESTION_TYPES.MCQ_MULTI) {
    const selected = Array.isArray(data.selected_options) ? data.selected_options : [];
    if (!selected.length) return 'Not answered';
    const byId = new Map((qConfig.options || []).map((o) => [o.id, o.text]));
    return selected.map((id) => (byId.get(id) ? `${id}. ${byId.get(id)}` : id)).join(', ');
  }
  if (qType === QUESTION_TYPES.TRUE_FALSE) {
    if (typeof data.selected_answer !== 'boolean') return 'Not answered';
    return data.selected_answer ? 'True' : 'False';
  }
  if (qType === QUESTION_TYPES.SHORT_ANSWER) {
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    return text || 'Not answered';
  }
  if (qType === QUESTION_TYPES.NUMERIC) {
    if (typeof data.value !== 'number' || !Number.isFinite(data.value)) return 'Not answered';
    return qConfig.unit ? `${data.value} ${qConfig.unit}` : String(data.value);
  }
  if (qType === QUESTION_TYPES.MATCHING) {
    const pairs = data.pairs && typeof data.pairs === 'object' ? Object.entries(data.pairs).filter(([, v]) => v) : [];
    if (!pairs.length) return 'Not answered';
    const choiceMap = new Map((qConfig.choices || []).map((c) => [c.id, c.text]));
    return pairs.map(([pId, cId]) => `${pId} → ${choiceMap.get(cId) ? `${cId} (${choiceMap.get(cId)})` : cId}`).join('; ');
  }
  if (qType === QUESTION_TYPES.ORDERING) {
    const order = Array.isArray(data.order) ? data.order : [];
    if (!order.length) return 'Not answered';
    const itemMap = new Map((qConfig.items || []).map((i) => [i.id, i.text]));
    return order.map((id) => (itemMap.get(id) ? `${id} (${itemMap.get(id)})` : id)).join(' → ');
  }
  return 'Not answered';
}

export function formatCorrectAnswerSummary(questionOrAnswerRow) {
  if (!questionOrAnswerRow) return '—';
  const q = questionOrAnswerRow.question_config && typeof questionOrAnswerRow.question_config === 'object'
    ? questionOrAnswerRow
    : hydrateQuestionRow(questionOrAnswerRow, { includeAnswerKey: true });
  const qType = q.question_type || DEFAULT_QUESTION_TYPE;
  const qConfig = q.question_config || {};
  const aKey = q.answer_key || {};

  if (qType === QUESTION_TYPES.MCQ_SINGLE) {
    const corr = q.correct_option || aKey.correct_option;
    if (!corr) return '—';
    const optMap = { A: q.option_a, B: q.option_b, C: q.option_c, D: q.option_d };
    const text = optMap[corr] ?? (qConfig.options || []).find((o) => o.id === corr)?.text ?? '';
    return text ? `${corr}. ${text}` : `Option ${corr}`;
  }
  if (qType === QUESTION_TYPES.MCQ_MULTI) {
    const corr = Array.isArray(aKey.correct_options) ? aKey.correct_options : [];
    const byId = new Map((qConfig.options || []).map((o) => [o.id, o.text]));
    return corr.map((id) => (byId.get(id) ? `${id}. ${byId.get(id)}` : id)).join(', ') || '—';
  }
  if (qType === QUESTION_TYPES.TRUE_FALSE) {
    if (typeof aKey.correct_answer !== 'boolean') return '—';
    return aKey.correct_answer ? 'True' : 'False';
  }
  if (qType === QUESTION_TYPES.SHORT_ANSWER) {
    const accepted = Array.isArray(aKey.accepted_answers) ? aKey.accepted_answers : [];
    return accepted.join(' / ') || '—';
  }
  if (qType === QUESTION_TYPES.NUMERIC) {
    if (aKey.value === undefined || aKey.value === null) return '—';
    const tol = Number(aKey.tolerance || 0);
    const unit = qConfig.unit ? ` ${qConfig.unit}` : '';
    return tol > 0 ? `${aKey.value} (±${tol})${unit}` : `${aKey.value}${unit}`;
  }
  if (qType === QUESTION_TYPES.MATCHING) {
    const pairs = aKey.pairs && typeof aKey.pairs === 'object' ? Object.entries(aKey.pairs) : [];
    const choiceMap = new Map((qConfig.choices || []).map((c) => [c.id, c.text]));
    return pairs.map(([pId, cId]) => `${pId} → ${choiceMap.get(cId) ? `${cId} (${choiceMap.get(cId)})` : cId}`).join('; ') || '—';
  }
  if (qType === QUESTION_TYPES.ORDERING) {
    const order = Array.isArray(aKey.correct_order) ? aKey.correct_order : [];
    const itemMap = new Map((qConfig.items || []).map((i) => [i.id, i.text]));
    return order.map((id) => (itemMap.get(id) ? `${id} (${itemMap.get(id)})` : id)).join(' → ') || '—';
  }
  return '—';
}

export function syncDraftFromForm(draft, form) {
  if (!draft || !form || typeof FormData === 'undefined') return draft;
  let data;
  try {
    data = new FormData(form);
  } catch {
    return draft;
  }

  if (data.has('question_text')) draft.question_text = String(data.get('question_text') ?? '');
  if (data.has('category')) draft.category = String(data.get('category') ?? '');
  if (data.has('difficulty')) draft.difficulty = String(data.get('difficulty') ?? '');
  if (data.has('explanation')) draft.explanation = String(data.get('explanation') ?? '');

  if (data.has('media_mode')) {
    const mode = String(data.get('media_mode') ?? 'none').trim().toLowerCase();
    if (mode === 'none' || mode === '') {
      draft.media.enabled = false;
    } else {
      draft.media.enabled = true;
      draft.media.type = mode;
    }
  }
  if (draft.media?.enabled) {
    if (data.has('media_url')) draft.media.url = String(data.get('media_url') ?? '');
    if (data.has('media_alt')) draft.media.alt = String(data.get('media_alt') ?? '');
    if (data.has('media_caption')) draft.media.caption = String(data.get('media_caption') ?? '');
  }

  const qType = draft.question_type || DEFAULT_QUESTION_TYPE;
  const td = draft.typeData?.[qType];
  if (!td) return draft;

  if (qType === QUESTION_TYPES.MCQ_SINGLE) {
    if (data.has('option_a')) td.option_a = String(data.get('option_a') ?? '');
    if (data.has('option_b')) td.option_b = String(data.get('option_b') ?? '');
    if (data.has('option_c')) td.option_c = String(data.get('option_c') ?? '');
    if (data.has('option_d')) td.option_d = String(data.get('option_d') ?? '');
    if (data.has('correct_option')) td.correct_option = String(data.get('correct_option') || 'A').toUpperCase();
  } else if (qType === QUESTION_TYPES.MCQ_MULTI) {
    td.options.forEach((opt, idx) => {
      const key = `multi_option_${idx}`;
      if (data.has(key)) opt.text = String(data.get(key) ?? '');
    });
    if (data.has('min_selections')) td.min_selections = String(data.get('min_selections') ?? '');
    if (data.has('max_selections')) td.max_selections = String(data.get('max_selections') ?? '');
  } else if (qType === QUESTION_TYPES.TRUE_FALSE) {
    if (data.has('correct_answer')) {
      td.correct_answer = String(data.get('correct_answer')).toLowerCase() !== 'false';
    }
    if (data.has('true_text')) td.true_text = String(data.get('true_text') ?? 'True');
    if (data.has('false_text')) td.false_text = String(data.get('false_text') ?? 'False');
  } else if (qType === QUESTION_TYPES.SHORT_ANSWER) {
    td.accepted_answers = td.accepted_answers.map((val, idx) => {
      const key = `accepted_answer_${idx}`;
      return data.has(key) ? String(data.get(key) ?? '') : val;
    });
    if (form.elements?.case_sensitive) {
      td.case_sensitive = Boolean(form.elements.case_sensitive.checked);
    }
    if (data.has('max_length')) td.max_length = Number(data.get('max_length') || 200);
    if (data.has('placeholder')) td.placeholder = String(data.get('placeholder') ?? '');
  } else if (qType === QUESTION_TYPES.NUMERIC) {
    if (data.has('numeric_value')) td.value = String(data.get('numeric_value') ?? '');
    if (data.has('numeric_tolerance')) td.tolerance = String(data.get('numeric_tolerance') ?? '0');
    if (form.elements?.allow_decimals) {
      td.allow_decimals = Boolean(form.elements.allow_decimals.checked);
    }
    if (data.has('numeric_unit')) td.unit = String(data.get('numeric_unit') ?? '');
    if (data.has('placeholder')) td.placeholder = String(data.get('placeholder') ?? '');
  } else if (qType === QUESTION_TYPES.MATCHING) {
    td.prompts.forEach((p, idx) => {
      const key = `matching_prompt_${idx}`;
      if (data.has(key)) p.text = String(data.get(key) ?? '');
      const pairKey = `matching_pair_${p.id}`;
      if (data.has(pairKey)) td.pairs[p.id] = String(data.get(pairKey) ?? '').toUpperCase();
    });
    td.choices.forEach((c, idx) => {
      const key = `matching_choice_${idx}`;
      if (data.has(key)) c.text = String(data.get(key) ?? '');
    });
  } else if (qType === QUESTION_TYPES.ORDERING) {
    const orderedIds = td.correct_order?.length === td.items.length ? td.correct_order : td.items.map((i) => i.id);
    const byId = new Map(td.items.map((item) => [item.id, item]));
    orderedIds.forEach((id, idx) => {
      const key = `ordering_item_${idx}`;
      const item = byId.get(id);
      if (item && data.has(key)) item.text = String(data.get(key) ?? '');
    });
  }

  return draft;
}
