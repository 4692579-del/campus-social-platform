const XIAOCUI_ACCOUNT_ID = '45214114';
const XIAOCUI_PROFILE = Object.freeze({ nickname: '小萃小萃', avatarFileID: '/images/ai/xiaocui.jpg' });
const isXiaocui = user => user?.accountId === XIAOCUI_ACCOUNT_ID;

function profileAppearance(user) {
  return isXiaocui(user) ? XIAOCUI_PROFILE : { nickname: user.nickname, avatarFileID: user.avatarFileID || '' };
}

module.exports = { XIAOCUI_ACCOUNT_ID, XIAOCUI_PROFILE, isXiaocui, profileAppearance };
