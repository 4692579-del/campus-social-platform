const userService = require('../../services/user');
const { describeUser } = require('../../utils/user-role');

Page({
  data: {
    user: null,
    identity: describeUser(null),
    modules: [
      { mark: '聊', title: '校园动态', description: '分享日常，发现同频的朋友' },
      { mark: '闲', title: '二手集市', description: '让闲置遇见新的主人' },
      { mark: '帮', title: '跑腿互助', description: '同学之间，搭把手就好' },
      { mark: '信', title: '消息互动', description: '让每一次交流都有回应' },
    ],
  },
  async onShow() {
    try {
      const user = await userService.restore();
      this.setData({ user, identity: describeUser(user) });
    } catch (error) {
      this.setData({ user: null, identity: describeUser(null) });
    }
  },
  openProfile() { wx.switchTab({ url: '/pages/profile/index' }); },
});
