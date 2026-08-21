-- SGO on Supabase — last round of `db advisors` findings against the live
-- project.
--
-- `revoke_sessions_for(target_profile uuid)` is the one genuine security
-- gap here, missed by every earlier pass (0013/0016/0019's revoke lists):
-- it was fully PUBLIC-executable, meaning ANY caller — anon included —
-- could revoke ANY user's sessions by guessing/knowing their profile id,
-- logging them out or locking out an admin on demand. It's meant to be
-- called only from inside set_pin()/set_profile_active(), never directly.
--
-- The rest (notify_feedback/notify_message/notify_task_assigned/
-- touch_updated_at/assign_task_code/enforce_task_transition/
-- set_notification_dedup_key/handle_new_auth_user) are all trigger
-- functions — Postgres refuses to call these directly regardless of
-- grants ("trigger functions can only be called as triggers"), so the
-- PUBLIC grant the advisor flags on them was never actually exploitable.
-- Revoked anyway for consistency with the least-privilege posture
-- everything else in this project follows, and because relying on "it's a
-- trigger function so it's safe" as the only safeguard is more fragile
-- than just not granting access nobody needs in the first place.

revoke execute on function revoke_sessions_for(uuid) from public;

revoke execute on function
  notify_feedback(),
  notify_message(),
  notify_task_assigned(),
  touch_updated_at(),
  assign_task_code(),
  enforce_task_transition(),
  set_notification_dedup_key(),
  handle_new_auth_user()
from public;
