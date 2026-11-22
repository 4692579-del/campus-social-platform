const { rememberSize } = require('./post-image-layout');

function postMedia(post) {
  if (!post) return [];
  if (Array.isArray(post.media) && post.media.length) {
    return post.media.map(item => {
      if (item.type === 'video') rememberSize(item.fileID, item.width, item.height);
      return { fileID: item.fileID, type: item.type, poster: item.poster || '' };
    });
  }
  return (Array.isArray(post.images) ? post.images : []).map(fileID => ({ fileID, type: 'image', poster: '' }));
}

module.exports = { postMedia };
