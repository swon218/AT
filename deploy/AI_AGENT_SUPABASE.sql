-- ATLAS AI v1. Run this file OR deploy/AI_AGENT_SUPABASE.sql, not both.
-- PRECHECK: inspect existing objects. Unexpected AI schemas fail without overwrite.
SELECT nspname FROM pg_namespace WHERE nspname='atlas_ai';
SELECT to_regclass('auth.users') AS required_auth_users;
BEGIN;
DO $$ BEGIN
  IF to_regclass('auth.users') IS NULL THEN RAISE EXCEPTION 'auth.users is required'; END IF;
  IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='atlas_ai') AND
     to_regclass('atlas_ai.schema_meta') IS NULL THEN
    RAISE EXCEPTION 'Unexpected atlas_ai schema: inspect manually';
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS atlas_ai;
-- Fingerprint includes columns, constraints, indexes, RLS, policies, ACLs and function definitions.
DO $$ DECLARE actual text; expected text; BEGIN
  IF to_regclass('atlas_ai.schema_meta') IS NOT NULL THEN
    EXECUTE 'SELECT fingerprint FROM atlas_ai.schema_meta WHERE version=1' INTO expected;
    SELECT md5(string_agg(v,E'\n' ORDER BY v)) INTO actual FROM (
      SELECT c.relname||':'||c.relkind::text||':'||c.relrowsecurity||':'||coalesce(c.relacl::text,'')||':'||
        coalesce((SELECT string_agg(a.attname||':'||a.atttypid||':'||a.attnotnull||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),''),',' ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'')||':'||
        coalesce((SELECT string_agg(pg_get_constraintdef(k.oid),',' ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),'')||':'||
        coalesce((SELECT string_agg(pg_get_indexdef(i.indexrelid),',' ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid),'') AS v
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='atlas_ai'
      UNION ALL SELECT p.oid::regprocedure::text||pg_get_functiondef(p.oid)||coalesce(p.proacl::text,'') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='atlas_ai' OR (n.nspname='public' AND p.proname='atlas_ai_rpc')
      UNION ALL SELECT polname||pg_get_expr(polqual,polrelid)||coalesce(pg_get_expr(polwithcheck,polrelid),'') FROM pg_policy WHERE polrelid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='atlas_ai')
    ) s;
    IF expected IS NULL OR actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'ATLAS AI schema drift: stop and inspect; no objects overwritten'; END IF;
  ELSIF EXISTS(SELECT 1 FROM pg_proc WHERE proname='atlas_ai_rpc') THEN
    RAISE EXCEPTION 'Unexpected existing atlas_ai_rpc';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS atlas_ai.schema_meta(version integer PRIMARY KEY CHECK(version=1),fingerprint text NOT NULL);
CREATE TABLE IF NOT EXISTS atlas_ai.guests(
  id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days'
);
CREATE TABLE IF NOT EXISTS atlas_ai.owners(
  key text PRIMARY KEY, user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  guest_id uuid UNIQUE REFERENCES atlas_ai.guests(id),
  CHECK((user_id IS NOT NULL)::int+(guest_id IS NOT NULL)::int=1),
  CHECK(key=CASE WHEN user_id IS NOT NULL THEN 'u:'||user_id::text ELSE 'g:'||guest_id::text END)
);
CREATE TABLE IF NOT EXISTS atlas_ai.rooms(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_key text NOT NULL REFERENCES atlas_ai.owners(key) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '새 대화' CHECK(char_length(title) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE(id,owner_key)
);
CREATE INDEX IF NOT EXISTS ai_rooms_owner ON atlas_ai.rooms(owner_key,updated_at DESC) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS atlas_ai.usage(
  owner_key text NOT NULL REFERENCES atlas_ai.owners(key) ON DELETE CASCADE, day date NOT NULL,
  reserved integer NOT NULL DEFAULT 0 CHECK(reserved>=0), used integer NOT NULL DEFAULT 0 CHECK(used>=0),
  PRIMARY KEY(owner_key,day)
);
CREATE TABLE IF NOT EXISTS atlas_ai.requests(
  id uuid PRIMARY KEY, owner_key text NOT NULL REFERENCES atlas_ai.owners(key) ON DELETE CASCADE,
  room_id uuid NOT NULL, day date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Seoul')::date,
  question text NOT NULL CHECK(char_length(question) BETWEEN 1 AND 6000),
  status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','partial','failed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz NOT NULL DEFAULT now()+interval '180 seconds',
  answer jsonb CHECK(answer IS NULL OR octet_length(answer::text)<=100000), purged_at timestamptz,
  usage jsonb NOT NULL DEFAULT '{"status":"unknown"}' CHECK(octet_length(usage::text)<=4000 AND jsonb_typeof(usage)='object' AND usage ? 'status' AND usage->>'status' IN ('known','unknown')),
  error_code text CHECK(error_code ~ '^[a-z_]{1,60}$'),
  FOREIGN KEY(room_id,owner_key) REFERENCES atlas_ai.rooms(id,owner_key), UNIQUE(id,owner_key), UNIQUE(id,room_id,owner_key),
  CHECK(status NOT IN ('completed','partial') OR answer IS NOT NULL OR purged_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ai_requests_owner ON atlas_ai.requests(owner_key,created_at DESC);
CREATE INDEX IF NOT EXISTS ai_requests_lease ON atlas_ai.requests(lease_until) WHERE status='running';
CREATE TABLE IF NOT EXISTS atlas_ai.messages(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, room_id uuid NOT NULL, owner_key text NOT NULL,
  request_id uuid NOT NULL, role text NOT NULL CHECK(role IN ('user','assistant')),
  content text NOT NULL CHECK(char_length(content) BETWEEN 1 AND 24000), answer jsonb CHECK(octet_length(answer::text)<=100000),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(request_id,role),
  FOREIGN KEY(room_id,owner_key) REFERENCES atlas_ai.rooms(id,owner_key) ON DELETE CASCADE,
  FOREIGN KEY(request_id,room_id,owner_key) REFERENCES atlas_ai.requests(id,room_id,owner_key),
  CHECK((role='user' AND answer IS NULL) OR (role='assistant' AND answer IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ai_messages_room ON atlas_ai.messages(room_id,id);
CREATE TABLE IF NOT EXISTS atlas_ai.steps(
  request_id uuid NOT NULL, owner_key text NOT NULL, seq integer NOT NULL CHECK(seq BETWEEN 1 AND 100),
  event jsonb NOT NULL CHECK(octet_length(event::text)<=12000 AND event ?& ARRAY['seq','kind','status'] AND (event->>'seq')::integer=seq AND event->>'kind' IN ('model','tool','validation') AND event->>'status' IN ('started','success','empty','partial','error')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(request_id,seq),
  FOREIGN KEY(request_id,owner_key) REFERENCES atlas_ai.requests(id,owner_key) ON DELETE CASCADE
);
CREATE OR REPLACE FUNCTION public.atlas_ai_rpc(action text, actor text, payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,atlas_ai AS $$
DECLARE r atlas_ai.requests; room atlas_ai.rooms; result jsonb; today date := (now() AT TIME ZONE 'Asia/Seoul')::date;
        uid uuid; gid uuid; n integer; s text; reqid uuid; days integer;
BEGIN
  IF action='maintenance' THEN
    days := greatest(1,least(30,coalesce((payload->>'guest_days')::int,7)));
    -- Never restart an uncertain paid request. Expired leases refund question reservation, usage remains unknown.
    FOR r IN SELECT * FROM atlas_ai.requests WHERE status='running' AND lease_until<now() ORDER BY owner_key LOOP
      IF NOT pg_try_advisory_xact_lock(hashtextextended(r.owner_key,0)) THEN CONTINUE; END IF;
      SELECT * INTO r FROM atlas_ai.requests WHERE id=r.id AND status='running' AND lease_until<now() FOR UPDATE;
      IF NOT FOUND THEN CONTINUE; END IF;
      UPDATE atlas_ai.requests SET status='failed',error_code='interrupted',usage=usage||'{"status":"unknown"}'::jsonb WHERE id=r.id;
      UPDATE atlas_ai.usage SET reserved=greatest(0,reserved-1) WHERE owner_key=r.owner_key AND day=r.day;
    END LOOP;
    UPDATE atlas_ai.rooms SET deleted_at=coalesce(deleted_at,now()) WHERE owner_key IN
      (SELECT o.key FROM atlas_ai.owners o JOIN atlas_ai.guests g ON g.id=o.guest_id WHERE g.created_at<now()-make_interval(days=>days))
      AND NOT EXISTS(SELECT 1 FROM atlas_ai.requests q WHERE q.room_id=atlas_ai.rooms.id AND q.status='running');
    DELETE FROM atlas_ai.messages m USING atlas_ai.rooms c WHERE m.room_id=c.id AND c.deleted_at IS NOT NULL;
    UPDATE atlas_ai.requests q SET question='[deleted]',answer=NULL,purged_at=now() WHERE EXISTS(SELECT 1 FROM atlas_ai.rooms c WHERE c.id=q.room_id AND c.deleted_at IS NOT NULL);
    DELETE FROM atlas_ai.steps WHERE created_at<now()-interval '30 days';
    UPDATE atlas_ai.requests SET question='[retention expired]',answer=NULL,purged_at=now() WHERE created_at<now()-interval '90 days' AND status<>'running';
    RETURN '{"ok":true}'::jsonb;
  END IF;
  IF action='guest_create' THEN
    gid := (payload->>'id')::uuid;
    INSERT INTO atlas_ai.guests(id,token_hash,expires_at) VALUES(gid,payload->>'token_hash',now()+make_interval(days=>greatest(1,least(30,coalesce((payload->>'days')::int,7)))));
    INSERT INTO atlas_ai.owners(key,guest_id) VALUES('g:'||gid::text,gid);
    RETURN jsonb_build_object('key','g:'||gid::text);
  END IF;
  IF action='guest_verify' THEN
    SELECT jsonb_build_object('key','g:'||id::text) INTO result FROM atlas_ai.guests
      WHERE id=(payload->>'id')::uuid AND token_hash=payload->>'token_hash' AND expires_at>now();
    IF result IS NULL THEN RAISE EXCEPTION 'guest_invalid'; END IF;
    RETURN result;
  END IF;
  IF actor ~ '^u:[0-9a-f-]{36}$' THEN
    uid := substring(actor FROM 3)::uuid;
    INSERT INTO atlas_ai.owners(key,user_id) VALUES(actor,uid) ON CONFLICT(key) DO NOTHING;
  ELSIF actor !~ '^g:[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'owner_invalid'; END IF;
  IF NOT EXISTS(SELECT 1 FROM atlas_ai.owners WHERE key=actor) THEN RAISE EXCEPTION 'owner_invalid'; END IF;
  -- Consistent lock order: owner, room, request. DELETE and completion cannot resurrect a room.
  PERFORM pg_advisory_xact_lock(hashtextextended(actor,0));
  IF action='rooms' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.updated_at DESC),'[]') INTO result FROM
      (SELECT c.*,(SELECT count(*) FROM atlas_ai.messages m WHERE m.room_id=c.id AND m.role='user') AS question_count FROM atlas_ai.rooms c WHERE owner_key=actor AND deleted_at IS NULL AND
       (coalesce(payload->>'search','')='' OR title ILIKE '%'||(payload->>'search')||'%') ORDER BY updated_at DESC LIMIT 100) c;
    RETURN result;
  ELSIF action='create_room' THEN
    IF (SELECT count(*) FROM atlas_ai.rooms WHERE owner_key=actor AND deleted_at IS NULL)>=100 THEN RAISE EXCEPTION 'room_limit'; END IF;
    INSERT INTO atlas_ai.rooms(owner_key) VALUES(actor) RETURNING * INTO room; RETURN to_jsonb(room);
  ELSIF action IN ('request','step','finish') THEN
    SELECT * INTO r FROM atlas_ai.requests WHERE id=(payload->>'request_id')::uuid AND owner_key=actor FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
    SELECT * INTO room FROM atlas_ai.rooms WHERE id=r.room_id AND owner_key=actor FOR UPDATE;
    IF action='request' THEN
      IF room.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'not_found'; END IF;
      SELECT coalesce(jsonb_agg(event ORDER BY seq),'[]') INTO result FROM atlas_ai.steps WHERE request_id=r.id;
      RETURN to_jsonb(r)||jsonb_build_object('steps',result);
    ELSIF action='step' THEN
      IF r.status<>'running' OR room.deleted_at IS NOT NULL THEN RETURN '{"accepted":false}'; END IF;
      INSERT INTO atlas_ai.steps(request_id,owner_key,seq,event) VALUES(r.id,actor,(payload->'event'->>'seq')::int,payload->'event') ON CONFLICT DO NOTHING;
      UPDATE atlas_ai.requests SET lease_until=now()+interval '180 seconds',usage=coalesce(payload->'usage',usage) WHERE id=r.id;
      RETURN '{"accepted":true}';
    ELSE
      IF r.status<>'running' THEN RETURN to_jsonb(r); END IF;
      s := payload->>'status';
      IF s NOT IN ('completed','partial','failed') THEN RAISE EXCEPTION 'invalid_status'; END IF;
      IF room.deleted_at IS NOT NULL THEN s := 'cancelled'; END IF;
      UPDATE atlas_ai.requests SET status=s, answer=CASE WHEN s IN ('completed','partial') THEN payload->'answer' ELSE NULL END,
        usage=CASE WHEN payload->'usage'->>'status'='unknown' THEN usage||(payload->'usage') ELSE coalesce(payload->'usage','{"status":"unknown"}') END,
        error_code=payload->>'error_code' WHERE id=r.id RETURNING * INTO r;
      UPDATE atlas_ai.usage SET reserved=reserved-1,used=used+CASE WHEN s IN ('completed','partial','cancelled') THEN 1 ELSE 0 END WHERE owner_key=actor AND day=r.day;
      IF s IN ('completed','partial') THEN
        INSERT INTO atlas_ai.messages(room_id,owner_key,request_id,role,content,answer) VALUES(r.room_id,actor,r.id,'assistant',r.answer->>'content',r.answer);
        UPDATE atlas_ai.rooms SET updated_at=now() WHERE id=r.room_id;
      END IF;
      RETURN to_jsonb(r);
    END IF;
  END IF;
  SELECT * INTO room FROM atlas_ai.rooms WHERE id=(payload->>'room_id')::uuid AND owner_key=actor AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF action='rename_room' THEN
    UPDATE atlas_ai.rooms SET title=payload->>'title',updated_at=now() WHERE id=room.id RETURNING * INTO room; RETURN to_jsonb(room);
  ELSIF action='delete_room' THEN
    UPDATE atlas_ai.rooms SET deleted_at=now(),title='[deleted]' WHERE id=room.id;
    DELETE FROM atlas_ai.messages WHERE room_id=room.id;
    UPDATE atlas_ai.requests SET question='[deleted]',answer=NULL,purged_at=now() WHERE room_id=room.id;
    RETURN '{"ok":true}';
  ELSIF action='messages' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]') INTO result FROM
      (SELECT * FROM atlas_ai.messages WHERE room_id=room.id AND owner_key=actor AND id<coalesce((payload->>'before')::bigint,9223372036854775807) ORDER BY id DESC LIMIT 50) m;
    RETURN jsonb_build_object('question_count',(SELECT count(*) FROM atlas_ai.messages WHERE room_id=room.id AND role='user'),'room',to_jsonb(room),'messages',result,'requests',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',q.id,'status',q.status,'error_code',q.error_code,'usage',q.usage) ORDER BY q.created_at),'[]') FROM atlas_ai.requests q WHERE q.id IN (SELECT (m->>'request_id')::uuid FROM jsonb_array_elements(result) m)));
  ELSIF action='reserve' THEN
    reqid := (payload->>'request_id')::uuid;
    SELECT * INTO r FROM atlas_ai.requests WHERE id=reqid;
    IF FOUND THEN
      IF r.owner_key<>actor OR r.room_id<>room.id OR r.question<>payload->>'question' THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
      RETURN to_jsonb(r)||'{"created":false}';
    END IF;
    IF EXISTS(SELECT 1 FROM atlas_ai.requests WHERE owner_key=actor AND status='running') THEN RAISE EXCEPTION 'concurrency_limit'; END IF;
    IF (SELECT count(*) FROM atlas_ai.requests WHERE owner_key=actor AND created_at>now()-interval '1 minute')>=10 THEN RAISE EXCEPTION 'minute_limit'; END IF;
    INSERT INTO atlas_ai.usage(owner_key,day) VALUES(actor,today) ON CONFLICT DO NOTHING;
    SELECT used+reserved INTO n FROM atlas_ai.usage WHERE owner_key=actor AND day=today FOR UPDATE;
    IF actor LIKE 'g:%' AND n>=2 THEN RAISE EXCEPTION 'daily_limit'; END IF;
    UPDATE atlas_ai.usage SET reserved=reserved+1 WHERE owner_key=actor AND day=today;
    INSERT INTO atlas_ai.requests(id,owner_key,room_id,question) VALUES(reqid,actor,room.id,payload->>'question') RETURNING * INTO r;
    INSERT INTO atlas_ai.messages(room_id,owner_key,request_id,role,content) VALUES(room.id,actor,reqid,'user',r.question);
    UPDATE atlas_ai.rooms SET updated_at=now(),title=CASE WHEN title='새 대화' THEN left(r.question,40) ELSE title END WHERE id=room.id;
    RETURN to_jsonb(r)||'{"created":true}';
  END IF;
  RAISE EXCEPTION 'unknown_action';
END $$;
REVOKE ALL ON SCHEMA atlas_ai FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA atlas_ai FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA atlas_ai FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA atlas_ai FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.atlas_ai_rpc(text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA atlas_ai TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA atlas_ai TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA atlas_ai TO service_role;
GRANT EXECUTE ON FUNCTION public.atlas_ai_rpc(text,text,jsonb) TO service_role;
DO $$ DECLARE t record; fingerprint text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='atlas_ai' LOOP
    EXECUTE format('ALTER TABLE atlas_ai.%I ENABLE ROW LEVEL SECURITY',t.tablename);
  END LOOP;
  SELECT md5(string_agg(v,E'\n' ORDER BY v)) INTO fingerprint FROM (
    SELECT c.relname||':'||c.relkind::text||':'||c.relrowsecurity||':'||coalesce(c.relacl::text,'')||':'||
      coalesce((SELECT string_agg(a.attname||':'||a.atttypid||':'||a.attnotnull||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),''),',' ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'')||':'||
      coalesce((SELECT string_agg(pg_get_constraintdef(k.oid),',' ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),'')||':'||
      coalesce((SELECT string_agg(pg_get_indexdef(i.indexrelid),',' ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid),'') AS v
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='atlas_ai'
    UNION ALL SELECT p.oid::regprocedure::text||pg_get_functiondef(p.oid)||coalesce(p.proacl::text,'') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='atlas_ai' OR (n.nspname='public' AND p.proname='atlas_ai_rpc')
    UNION ALL SELECT polname||pg_get_expr(polqual,polrelid)||coalesce(pg_get_expr(polwithcheck,polrelid),'') FROM pg_policy WHERE polrelid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='atlas_ai')
  ) s;
  INSERT INTO atlas_ai.schema_meta VALUES(1,fingerprint) ON CONFLICT(version) DO UPDATE SET fingerprint=excluded.fingerprint;
END $$;
COMMIT;
-- POSTCHECK: every table has RLS; client roles have no table/sequence/RPC privileges.
SELECT c.relname,c.relrowsecurity,c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='atlas_ai' ORDER BY c.relname;
SELECT conrelid::regclass,conname,pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='atlas_ai'::regnamespace ORDER BY conrelid,conname;
SELECT has_function_privilege('anon','public.atlas_ai_rpc(text,text,jsonb)','EXECUTE') AS anon_rpc,
       has_function_privilege('authenticated','public.atlas_ai_rpc(text,text,jsonb)','EXECUTE') AS user_rpc,
       has_function_privilege('service_role','public.atlas_ai_rpc(text,text,jsonb)','EXECUTE') AS server_rpc;
