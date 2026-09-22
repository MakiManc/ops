-- Photos live here because Mintsoft cannot serve them.
--
-- 135 of its 337 lines carry an ImageURL, and every one points at
-- om.mintsoft.co.uk/Image/GetImage/<id>, which answers HTTP 500 — anonymously, with a
-- valid API key, and with full browser headers alike. A 500 is a broken server, not an
-- auth challenge, so there is nothing to unlock. Re-checked 2026-09-22 across nine
-- routes before building this.
--
-- The bytes sit in D1 rather than object storage because the whole catalogue is ~97
-- photos at roughly 60KB each once resized — about 6MB, which SQLite holds without
-- complaint. It also needs no second service, no new credentials and no bucket to
-- provision. Everything goes through src/server/db/photos.ts, so moving to R2 later
-- means rewriting that one module, not hunting blobs through the codebase.
CREATE TABLE product_photos (
  -- One photo per product. Re-uploading replaces it, which is what people expect when
  -- they take a better picture.
  product_id   INTEGER PRIMARY KEY REFERENCES products (id) ON DELETE CASCADE,

  bytes        BLOB    NOT NULL,
  content_type TEXT    NOT NULL,

  -- Stored rather than derived from length(bytes) so the listing can show sizes without
  -- reading every photo out of the database.
  byte_size    INTEGER NOT NULL CHECK (byte_size > 0),

  -- Lets the browser skip the download on a repeat visit. Content-addressed, so a
  -- replaced photo gets a new one and caches invalidate themselves.
  etag         TEXT    NOT NULL,

  uploaded_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
  uploaded_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
