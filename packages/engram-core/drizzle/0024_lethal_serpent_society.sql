DROP INDEX "idx_dimension_events_run";--> statement-breakpoint
-- EGR-CR-056: 建唯一索引前先清历史重复 (run_id, dimension)——保留每组按 (created_at, id) 的最后一行、删其余。
-- 现网 dimension_events 是 append-only 报告口径表（绝不进在线判据/校准 g），同 (run_id, dimension) 多行本是被本
-- finding 判定为脏数据的重复批；唯一约束的语义是「同一 run 同一维度至多一行」，故合法保留的是最新读数。
DELETE FROM "dimension_events" a
USING "dimension_events" b
WHERE a."run_id" = b."run_id"
  AND a."dimension" = b."dimension"
  AND (a."created_at", a."id") < (b."created_at", b."id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_dimension_events_run_dim" ON "dimension_events" USING btree ("run_id","dimension");
