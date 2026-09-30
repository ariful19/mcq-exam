import { sql } from 'drizzle-orm';
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const questions = sqliteTable('questions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  archived: integer('archived').notNull().default(0),
  question_text: text('question_text').notNull(),
  option_a: text('option_a').notNull(),
  option_b: text('option_b').notNull(),
  option_c: text('option_c').notNull(),
  option_d: text('option_d').notNull(),
  correct_option: text('correct_option').notNull(),
  category: text('category').notNull().default(''),
  difficulty: text('difficulty').notNull().default(''),
  explanation: text('explanation').notNull().default(''),
  created_at: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [check('questions_correct_option_check', sql`${table.correct_option} IN ('A','B','C','D')`), index('idx_questions_category_difficulty').on(table.category, table.difficulty)]);

export const exams = sqliteTable('exams', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  duration_minutes: integer('duration_minutes').notNull(),
  subject: text('subject').notNull().default(''),
  negative_mark: real('negative_mark').notNull().default(0),
  status: text('status').notNull().default('draft'),
  show_score: integer('show_score').notNull().default(0),
  show_answers: integer('show_answers').notNull().default(0),
  created_at: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check('exams_status_check', sql`${table.status} IN ('draft','published','closed')`),
  check('exams_duration_check', sql`${table.duration_minutes} > 0`),
  check('exams_visibility_check', sql`${table.show_answers}=0 OR ${table.show_score}=1`),
]);

export const examQuestions = sqliteTable('exam_questions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  exam_id: integer('exam_id').notNull().references(() => exams.id, { onDelete: 'cascade' }),
  question_id: integer('question_id').notNull().references(() => questions.id, { onDelete: 'restrict' }),
  marks: real('marks').notNull().default(1),
  sort_order: integer('sort_order').notNull().default(0),
}, (table) => [uniqueIndex('exam_questions_exam_question_unique').on(table.exam_id, table.question_id)]);

export const attempts = sqliteTable('attempts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  exam_id: integer('exam_id').notNull().references(() => exams.id, { onDelete: 'restrict' }),
  access_token: text('access_token').notNull().unique(),
  student_name: text('student_name').notNull(),
  roll_number: text('roll_number').notNull(),
  email: text('email').notNull().default(''),
  address: text('address').notNull().default(''),
  started_at: text('started_at').notNull(),
  submitted_at: text('submitted_at'),
  score: real('score'),
  status: text('status').notNull().default('in_progress'),
}, (table) => [
  check('attempts_status_check', sql`${table.status} IN ('in_progress','submitted','auto_submitted')`),
  index('idx_attempts_exam_started').on(table.exam_id, table.started_at),
]);

export const answers = sqliteTable('answers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  attempt_id: integer('attempt_id').notNull().references(() => attempts.id, { onDelete: 'cascade' }),
  question_id: integer('question_id').notNull().references(() => questions.id, { onDelete: 'restrict' }),
  selected_option: text('selected_option'),
  is_correct: integer('is_correct'),
  marks_awarded: real('marks_awarded').notNull().default(0),
}, (table) => [
  uniqueIndex('answers_attempt_question_unique').on(table.attempt_id, table.question_id),
  check('answers_selected_option_check', sql`${table.selected_option} IS NULL OR ${table.selected_option} IN ('A','B','C','D')`),
  check('answers_is_correct_check', sql`${table.is_correct} IS NULL OR ${table.is_correct} IN (0,1)`),
]);

export const siteMeta = sqliteTable('site_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const adminAuth = sqliteTable('admin_auth', {
  id: integer('id').primaryKey(),
  password_salt: text('password_salt').notNull(),
  password_hash: text('password_hash').notNull(),
  session_version: integer('session_version').notNull().default(1),
}, (table) => [check('admin_auth_singleton_check', sql`${table.id}=1`)]);
