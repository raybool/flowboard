CREATE TABLE "used_refresh_tokens" (
    "token_hash" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "used_refresh_tokens_pkey" PRIMARY KEY ("token_hash")
);

CREATE INDEX "used_refresh_tokens_session_id_idx" ON "used_refresh_tokens"("session_id");

ALTER TABLE "used_refresh_tokens" ADD CONSTRAINT "used_refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
