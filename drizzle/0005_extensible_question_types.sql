PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL,
	`question_text` text NOT NULL,
	`question_type` text DEFAULT 'mcq_single' NOT NULL,
	`option_a` text DEFAULT '' NOT NULL,
	`option_b` text DEFAULT '' NOT NULL,
	`option_c` text DEFAULT '' NOT NULL,
	`option_d` text DEFAULT '' NOT NULL,
	`correct_option` text DEFAULT '' NOT NULL,
	`question_config` text DEFAULT '{}' NOT NULL,
	`answer_key` text DEFAULT '{}' NOT NULL,
	`media` text,
	`category` text DEFAULT '' NOT NULL,
	`difficulty` text DEFAULT '' NOT NULL,
	`explanation` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "questions_type_check" CHECK("__new_questions"."question_type" IN ('mcq_single','mcq_multi','true_false','short_answer','numeric','matching','ordering')),
	CONSTRAINT "questions_correct_option_check" CHECK(("__new_questions"."question_type" = 'mcq_single' AND "__new_questions"."correct_option" IN ('A','B','C','D')) OR ("__new_questions"."question_type" != 'mcq_single' AND ("__new_questions"."correct_option" = '' OR "__new_questions"."correct_option" IN ('A','B','C','D'))))
);
--> statement-breakpoint
INSERT INTO `__new_questions` (
	`id`,
	`archived`,
	`question_text`,
	`question_type`,
	`option_a`,
	`option_b`,
	`option_c`,
	`option_d`,
	`correct_option`,
	`question_config`,
	`answer_key`,
	`media`,
	`category`,
	`difficulty`,
	`explanation`,
	`created_at`
)
SELECT
	`id`,
	`archived`,
	`question_text`,
	'mcq_single',
	`option_a`,
	`option_b`,
	`option_c`,
	`option_d`,
	`correct_option`,
	json_object(
		'options', json_array(
			json_object('id', 'A', 'text', `option_a`),
			json_object('id', 'B', 'text', `option_b`),
			json_object('id', 'C', 'text', `option_c`),
			json_object('id', 'D', 'text', `option_d`)
		)
	),
	json_object('correct_option', `correct_option`),
	NULL,
	`category`,
	`difficulty`,
	`explanation`,
	`created_at`
FROM `questions`;
--> statement-breakpoint
DROP TABLE `questions`;
--> statement-breakpoint
ALTER TABLE `__new_questions` RENAME TO `questions`;
--> statement-breakpoint
CREATE INDEX `idx_questions_category_difficulty` ON `questions` (`category`,`difficulty`);
--> statement-breakpoint
CREATE INDEX `idx_questions_type` ON `questions` (`question_type`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_questions_sync_legacy_mcq_insert`
AFTER INSERT ON `questions`
WHEN NEW.`question_type` = 'mcq_single' AND (NEW.`question_config` = '{}' OR NEW.`answer_key` = '{}')
BEGIN
	UPDATE `questions`
	SET
		`question_config` = CASE
			WHEN NEW.`question_config` = '{}' THEN json_object(
				'options', json_array(
					json_object('id', 'A', 'text', NEW.`option_a`),
					json_object('id', 'B', 'text', NEW.`option_b`),
					json_object('id', 'C', 'text', NEW.`option_c`),
					json_object('id', 'D', 'text', NEW.`option_d`)
				)
			)
			ELSE NEW.`question_config`
		END,
		`answer_key` = CASE
			WHEN NEW.`answer_key` = '{}' THEN json_object('correct_option', NEW.`correct_option`)
			ELSE NEW.`answer_key`
		END
	WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_questions_sync_legacy_mcq_update`
AFTER UPDATE OF `option_a`, `option_b`, `option_c`, `option_d`, `correct_option` ON `questions`
WHEN NEW.`question_type` = 'mcq_single'
	AND (OLD.`option_a` != NEW.`option_a` OR OLD.`option_b` != NEW.`option_b` OR OLD.`option_c` != NEW.`option_c` OR OLD.`option_d` != NEW.`option_d` OR OLD.`correct_option` != NEW.`correct_option`)
	AND NEW.`question_config` = OLD.`question_config`
	AND NEW.`answer_key` = OLD.`answer_key`
BEGIN
	UPDATE `questions`
	SET
		`question_config` = json_object(
			'options', json_array(
				json_object('id', 'A', 'text', NEW.`option_a`),
				json_object('id', 'B', 'text', NEW.`option_b`),
				json_object('id', 'C', 'text', NEW.`option_c`),
				json_object('id', 'D', 'text', NEW.`option_d`)
			)
		),
		`answer_key` = json_object('correct_option', NEW.`correct_option`)
	WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
ALTER TABLE `answers` ADD `answer_data` text;
--> statement-breakpoint
UPDATE `answers` SET `answer_data` = json_object('selected_option', `selected_option`) WHERE `selected_option` IS NOT NULL AND `answer_data` IS NULL;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_answers_sync_legacy_insert`
AFTER INSERT ON `answers`
WHEN NEW.`selected_option` IS NOT NULL AND NEW.`answer_data` IS NULL
BEGIN
	UPDATE `answers`
	SET `answer_data` = json_object('selected_option', NEW.`selected_option`)
	WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_answers_sync_legacy_update`
AFTER UPDATE OF `selected_option` ON `answers`
WHEN (OLD.`selected_option` IS NOT NEW.`selected_option`)
	AND (NEW.`answer_data` IS OLD.`answer_data`)
BEGIN
	UPDATE `answers`
	SET `answer_data` = CASE
		WHEN NEW.`selected_option` IS NOT NULL THEN json_object('selected_option', NEW.`selected_option`)
		ELSE NULL
	END
	WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
