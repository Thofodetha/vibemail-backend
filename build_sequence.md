# VibeMail Engine Build Sequence

Each unit is built in order. A unit is done only when its verify step passes. Do not start the next unit before then.

1. **Provider abstraction interface.**
   Verify: TypeScript compiles clean, and the interface defines all required methods.

2. **Gmail OAuth layer with token persistence listener.**
   Verify: The OAuth flow completes, tokens store in Supabase, and refresh works without a token mismatch.

3. **Sync and read layer.**
   Verify: Initial sync fetches fifty messages, and message objects match the CONTRACT.md data model exactly.

4. **Pub/Sub webhook receiver.**
   Verify: The webhook receives a notification and fetches the correct delta via history ID.

5. **Send layer.**
   Verify: A message sends successfully via the Gmail API on behalf of an authenticated user.

6. **Vercel API function entry points.**
   Verify: All four endpoints respond correctly in local preview.

7. **Integration tests.**
   Verify: The full test suite passes with no skipped tests against a live Supabase instance.
