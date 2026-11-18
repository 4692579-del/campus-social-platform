function projectComment(row, target) {
  const liked = Boolean(target.liked);
  return { ...row, liked, folded: Boolean(target.folded),
    likeCount: Math.max(0, (Number(row.likeCount) || 0) + (Boolean(row.liked) === liked ? 0 : liked ? 1 : -1)) };
}
function reactComment(row, kind, active) {
  return projectComment(row, { liked: kind === 'like' ? active : row.liked,
    folded: kind === 'fold' ? active : active ? false : row.folded });
}
module.exports = { projectComment, reactComment };
