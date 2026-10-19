# Question import formats

## Excel version 2

Download `mcq-question-template-v2.xlsx` from the Question bank. The `Questions` sheet contains one example for each of the nine supported types; the `Instructions` sheet identifies format version 2 and explains columns.

- Keep one header row per question worksheet. Every populated question sheet is validated, not just the first. The supplied self-identifying Instructions sheet is metadata; unrecognized populated sheets are diagnosed, not silently skipped.
- Required question metadata: Question and Category (or the fallback subject selected at upload). Subject aliases Category. Missing Question Type means legacy single-choice MCQ.
- Types: `mcq_single`, `mcq_multi`, `true_false`, `yes_no`, `fill_blank`, `short_answer`, `numeric`, `matching`, `ordering`.
- Marks is a positive number up to 1000, default 1. It is copied into each saved exam. Blank Marks preserves `question_config.default_marks` when supplied.
- Legacy Option A–D and Correct Answer columns remain supported; Correct Option aliases Correct Answer. Question Config and Answer Key accept JSON for type-specific options and keys.
- Fill blanks support IDs, labels, max_length (1–250), global/per-blank case_sensitive settings and accepted exact variants. Matching and ordering use IDs, not display strings. Ordering chunks must be distinct.
- Use limited `<b>`, `<strong>`, `<i>`, `<em>`, `<u>`, `<s>`, `<del>`, `<strike>`, `<br>` or `<code>` formatting. Newlines are preserved as line breaks. Unsafe tags/attributes are removed. No arbitrary HTML, scripts or video.
- Media may be `{"type":"image","placeholder":true}` or `{"type":"audio","placeholder":true}`. Attach the media later; unresolved placeholders block publishing, not media-free questions.
- At most 900 question rows across all worksheets. A malformed row, unsupported version/type, ambiguous duplicate header, or storage failure prevents every write. Diagnostics name the worksheet and row.

## Bulk paste version 2

Start with `MCQ-PASTE: 2`, then a blank line. Separate question blocks with one blank line. Number question prompts sequentially as `1. Prompt`, `2. Prompt`, etc. The original headerless numbered A–D/Answer format is still accepted. A header with another version is rejected.

Common single-occurrence fields are `Type:`, `Subject:` (alias `Category:`), `Difficulty:`, `Marks:`, `Explanation:`, `Answer:`, `Tolerance:`, `Stimulus:` and `Media:`. Do not duplicate a field or option. Unknown lines are errors. Use `<br>` within one prompt/choice/passage line for a line break; a blank line starts the next question.

```text
MCQ-PASTE: 2

1. Which option is <u>correct</u>?
Type: mcq_single
Subject: Reading
Marks: 2
A. First
B. Second
C. Third
D. Fourth
Answer: A

2. Select the primes.
Type: mcq_multi
Subject: Mathematics
A. 2
B. 3
C. 4
Answer: A, B

3. The Earth is round.
Type: true_false
Answer: True

4. Is water a liquid at room temperature?
Type: yes_no
Answer: Yes

5. Water is [blank1]; salt is [blank2].
Type: fill_blank
Answer: B1=H2O|H₂O;B2=NaCl
Media: [image: placeholder]

6. Name the capital.
Type: short_answer
Answer: Dhaka|ঢাকা

7. Enter standard gravity.
Type: numeric
Answer: 9.8
Tolerance: 0.1

8. Arrange the lifecycle.
Type: ordering
1. Egg
2. Caterpillar
3. Pupa
4. Butterfly
Answer: 1, 2, 3, 4

9. Match the capitals.
Type: matching
Match: France -> Paris
Match: Germany -> Berlin
Stimulus: Geography | Read the countries and their capital cities.
```

The fallback subject selected at import applies where Subject is omitted. Type inference for the legacy format is deterministic, but explicitly specifying Type is recommended for new multi-type files. A fill-blank Answer uses `|` between acceptable exact variants and `;` between blanks. Paste defaults to case-insensitive blank comparison; use the question editor or Excel JSON for per-blank case settings and maximum lengths. Yes/No and True/False require those literal answer names. Ordering requires actual numbered chunks; it never invents missing chunk text.

A maximum of 300 blocks is accepted. All blocks are parsed and validated before any database write. A single bad block prevents the entire import; diagnostics identify the question and offending line where applicable. No AI/NLP guessing is used.
