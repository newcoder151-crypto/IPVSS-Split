/**
 * This dashboard serves one post, so every record is scoped to the signed-in officer's post.
 * (Out-of-scope records are reported as 404, never 403, so other posts' ids are not confirmed to exist.)
 */

/** SQL condition limiting rows to the officer's post; `postAlias` is the rpf_post alias in the query. */
function postScopeSql(user, postAlias, params) {
  params.push(user.post_id);
  return `${postAlias}.id = $${params.length}`;
}

/** True if the officer may see rows belonging to `postId`. */
const canSeePost = (user, postId) => Number(user.post_id) === Number(postId);

/** Notifications belong to a post. */
function notificationScope(user, params) {
  params.push(user.post_id);
  return `n.post_id = $${params.length}`;
}

module.exports = { postScopeSql, canSeePost, notificationScope };
