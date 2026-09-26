CREATE TABLE `answers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` integer NOT NULL,
	`question_id` integer NOT NULL,
	`selected_option` text,
	`is_correct` integer,
	`marks_awarded` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "answers_selected_option_check" CHECK("answers"."selected_option" IS NULL OR "answers"."selected_option" IN ('A','B','C','D')),
	CONSTRAINT "answers_is_correct_check" CHECK("answers"."is_correct" IS NULL OR "answers"."is_correct" IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `answers_attempt_question_unique` ON `answers` (`attempt_id`,`question_id`);--> statement-breakpoint
CREATE TABLE `attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`exam_id` integer NOT NULL,
	`access_token` text NOT NULL,
	`student_name` text NOT NULL,
	`roll_number` text NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`started_at` text NOT NULL,
	`submitted_at` text,
	`score` real,
	`status` text DEFAULT 'in_progress' NOT NULL,
	FOREIGN KEY (`exam_id`) REFERENCES `exams`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "attempts_status_check" CHECK("attempts"."status" IN ('in_progress','submitted','auto_submitted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_access_token_unique` ON `attempts` (`access_token`);--> statement-breakpoint
CREATE INDEX `idx_attempts_exam_started` ON `attempts` (`exam_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `exam_questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`exam_id` integer NOT NULL,
	`question_id` integer NOT NULL,
	`marks` real DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`exam_id`) REFERENCES `exams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exam_questions_exam_question_unique` ON `exam_questions` (`exam_id`,`question_id`);--> statement-breakpoint
CREATE TABLE `exams` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`duration_minutes` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`show_score` integer DEFAULT 0 NOT NULL,
	`show_answers` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "exams_status_check" CHECK("exams"."status" IN ('draft','published','closed')),
	CONSTRAINT "exams_duration_check" CHECK("exams"."duration_minutes" > 0),
	CONSTRAINT "exams_visibility_check" CHECK("exams"."show_answers"=0 OR "exams"."show_score"=1)
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`question_text` text NOT NULL,
	`option_a` text NOT NULL,
	`option_b` text NOT NULL,
	`option_c` text NOT NULL,
	`option_d` text NOT NULL,
	`correct_option` text NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`difficulty` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "questions_correct_option_check" CHECK("questions"."correct_option" IN ('A','B','C','D'))
);
--> statement-breakpoint
CREATE INDEX `idx_questions_category_difficulty` ON `questions` (`category`,`difficulty`);--> statement-breakpoint
CREATE TABLE `site_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
