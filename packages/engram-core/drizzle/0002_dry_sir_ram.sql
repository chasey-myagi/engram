CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN "embedding" vector(1024);--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN "embedding_version" text;--> statement-breakpoint
CREATE INDEX "idx_claim_embedding_hnsw" ON "claim" USING hnsw ("embedding" vector_cosine_ops);
