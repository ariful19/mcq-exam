-- Add private public-ID mappings without rewriting saved answers or keys.
UPDATE questions
  SET answer_key=json_set(answer_key, '$.public_item_ids', json((
    SELECT json_group_object(json_extract(item.value,'$.id'), 'O' || hex(randomblob(16)))
    FROM json_each(question_config, '$.items') item
  )))
  WHERE question_type='ordering' AND json_valid(question_config) AND json_valid(answer_key)
    AND json_type(question_config, '$.items')='array'
    AND json_type(answer_key, '$.public_item_ids') IS NULL;
