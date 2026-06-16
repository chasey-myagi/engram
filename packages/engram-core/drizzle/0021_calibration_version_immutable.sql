-- EGR-CR-009: calibration_map 的 version→knots 不可变兜底（DB 层）。
-- 应用层（calibration-store.appendCalibrationMapTx）是首要防线：同 version 已有定义且 knots 不一致即 fail-loud。
-- 本 migration 加 DB 兜底，封死「绕过 store 的脏直写 / 并发 TOCTOU」：
--   1) 新增 knots_hash 列（store 落库时写 md5(canonical(knots))，与本文件回填口径逐字节一致）。
--   2) 回填存量行的 knots_hash。
--   3) (version, knots_hash) 普通索引：加速「按 version 查已存在 hash」的门 + 触发器查询。
--   4) BEFORE INSERT 触发器：同 version 已存在**不同** knots_hash 的行 → RAISE EXCEPTION 拒插。
--      （纯 UNIQUE 表达不了「同 version 多行但 knots 必须同」——活动指针 / 回退复用 'identity' 再 append 即激活
--       是合法的「同 version 多行同内容」，不能被唯一约束误杀；故用触发器只拦「同 version 异内容」。）
ALTER TABLE "calibration_map" ADD COLUMN "knots_hash" text;
--> statement-breakpoint
UPDATE "calibration_map" SET "knots_hash" = md5(COALESCE((
  SELECT string_agg((e->>'x') || ':' || (e->>'y'), ',' ORDER BY ord)
  FROM jsonb_array_elements("knots") WITH ORDINALITY AS arr(e, ord)
), '')) WHERE "knots_hash" IS NULL;
--> statement-breakpoint
ALTER TABLE "calibration_map" ALTER COLUMN "knots_hash" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_calibration_map_version_knots" ON "calibration_map" USING btree ("version","knots_hash");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "calibration_map_version_immutable"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "calibration_map"
    WHERE "version" = NEW."version" AND "knots_hash" <> NEW."knots_hash"
  ) THEN
    RAISE EXCEPTION 'calibration: refuse to redefine version "%" with different knots (version->knots is immutable, EGR-CR-009)', NEW."version"
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "trg_calibration_map_version_immutable"
  BEFORE INSERT ON "calibration_map"
  FOR EACH ROW EXECUTE FUNCTION "calibration_map_version_immutable"();
