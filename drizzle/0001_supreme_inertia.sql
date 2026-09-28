CREATE TABLE `admin_auth` (
	`id` integer PRIMARY KEY NOT NULL,
	`password_salt` text NOT NULL,
	`password_hash` text NOT NULL,
	`session_version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "admin_auth_singleton_check" CHECK("admin_auth"."id"=1)
);
--> statement-breakpoint
ALTER TABLE `attempts` ADD `address` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `exams` ADD `subject` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `exams` ADD `negative_mark` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `explanation` text DEFAULT '' NOT NULL;