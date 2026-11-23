function commentsDisabled(author) {
  return author?.officialVerified === true && author.squareCommentsDisabled === true;
}

async function requireOpenComments(source, post) {
  if (post.scope === 'news' && post.contentType === 'news') {
    throw Object.assign(new Error('全球动态暂不支持评论'), { code: 'COMMENTS_DISABLED' });
  }
  const author = (await source.collection('users').doc(post.authorId).get()).data;
  if (commentsDisabled(author)) {
    throw Object.assign(new Error('该账号已关闭评论'), { code: 'COMMENTS_DISABLED' });
  }
}

module.exports = { commentsDisabled, requireOpenComments };
