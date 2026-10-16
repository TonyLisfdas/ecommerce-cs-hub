/**
 * 八大电商平台客服工作台注册表（可同时被 Electron 主进程与渲染进程引用）
 * 设计原则：
 * 1. 优先直连官方独立网页版客服工作台（不进繁杂的商家后台首页）
 * 2. 对于自带后台侧边栏的平台（如小红书千帆、微信小店、闲鱼等），通过 cleanCss 注入自动隐藏非客服菜单，只留原版聊天面板
 * 3. 配置精准的未读消息 DOM 选择器、标题关键词与登录框选择器
 */

const PLATFORMS = [
  {
    id: 'douyin',
    hasCustomerService: true,
    orderUrl: 'https://fxg.jinritemai.com/ffa/morder/order/list',
    orderUnreadKeyword: ['待发货', '待发货订单', '未发货', '待处理发货'], // v11 Phase D: 订单页「待发货」数字关键词
    name: '抖店·飞鸽',
    fullName: '抖店飞鸽客服工作台',
    shortName: '抖店',
    color: '#FE2C55',
    bgLight: 'rgba(254, 44, 85, 0.14)',
    iconText: '抖',
    badgeColor: '#FE2C55',
    // 直达飞鸽PC网页版客服工作台（纯客服界面，不含抖店后台）
    url: 'https://im.jinritemai.com/pc_seller_v2/main/workspace',
    backupUrls: [
      { label: '飞鸽IM主工作台（纯客服推荐）', url: 'https://im.jinritemai.com/pc_seller_v2/main/workspace' },
      { label: '抖店登录入口（登录后跳飞鸽）', url: 'https://fxg.jinritemai.com/login/common' }
    ],
    supportWin32Embed: false,
    unreadSelectors: [
      '.unread-num',
      '[class*="unreadCount"]',
      '[class*="unread-badge"]',
      '.auxo-badge-count',
      '.byte-badge-count',
      '[class*="session-item"] [class*="badge"]'
    ],
    loginSelectors: {
      switchPasswordTab: ['[class*="password-tab"]', 'div:contains("密码登录")', 'span:contains("账号登录")'],
      username: ['input[placeholder*="手机号"]', 'input[placeholder*="邮箱"]', 'input[placeholder*="账号"]', 'input[name="username"]', 'input[type="text"]'],
      password: ['input[type="password"]', 'input[placeholder*="密码"]'],
      agreement: ['input[type="checkbox"]', '.auxo-checkbox-input'],
      submit: ['button[type="submit"]', 'button[class*="login-btn"]', '.auxo-btn-primary']
    },
    // 纯净客服模式注入CSS：隐藏顶部活动横幅、右侧不必要插件推广栏，让飞鸽聊天区占满100%窗口
    cleanCss: "",
    notes: '官方原生支持网页版飞鸽工作台，100%纯客服界面，Cookie持久化后可长期免扫码/免密保持登录。',
    sampleBuyers: [
      { name: '潮流穿搭小鹿', avatar: '鹿', time: '刚刚', msg: '亲，这件黑色卫衣165cm 52kg穿M码还是L码合适呀？今天能发货吗？', orderNo: 'DY2026101488921', product: '重磅纯棉连帽卫衣女秋冬加绒', price: '¥129.00' },
      { name: '海淀张先生', avatar: '张', time: '2分钟前', msg: '帮我改一下收货地址，刚刚拍错成公司地址了！', orderNo: 'DY2026101488304', product: '复古水洗直筒牛仔裤男', price: '¥158.00' },
      { name: '甜心草莓酱', avatar: '莓', time: '10分钟前', msg: '直播间领的优惠券怎么用不了呀？', orderNo: '未下单咨询', product: '羊毛针织开衫外套', price: '¥199.00' }
    ]
  },
  {
    id: 'pinduoduo',
    hasCustomerService: true,
    orderUrl: 'https://mms.pinduoduo.com/orders/order_list.html',
    orderUnreadKeyword: ['待发货', '待发货订单', '未发货', '待处理发货'], // v11 Phase D: 订单页「待发货」数字关键词
    name: '拼多多·多多客服',
    fullName: '拼多多网页版客服工作台',
    shortName: '拼多多',
    color: '#E02E24',
    bgLight: 'rgba(224, 46, 36, 0.14)',
    iconText: '拼',
    badgeColor: '#E02E24',
    // 直达拼多多网页版独立客服聊天窗口
    url: 'https://mms.pinduoduo.com/chat-merchant/index.html',
    backupUrls: [
      { label: '多多网页版独立客服台（推荐）', url: 'https://mms.pinduoduo.com/chat-merchant/index.html' },
      { label: '拼多多商家统一登录页', url: 'https://mms.pinduoduo.com/login/' }
    ],
    supportWin32Embed: true,
    win32ProcessName: 'PddWorkbench',
    win32TitleKeywords: ['多多进宝', '拼多多商家工作台', '客服平台'],
    unreadSelectors: [
      '.chat-unread-dot',
      '.unread-num',
      '[class*="unread"]',
      '.beast-badge-count',
      '.msg-unread-count',
      '.session-list-item .badge'
    ],
    loginSelectors: {
      switchPasswordTab: ['.tab-operate .tab-item:last-child', 'div:contains("账户登录")', 'span:contains("账号登录")'],
      username: ['#usernameId', 'input[placeholder*="手机号"]', 'input[placeholder*="账号"]', 'input[type="text"]'],
      password: ['#passwordId', 'input[type="password"]', 'input[placeholder*="密码"]'],
      agreement: ['input[type="checkbox"]'],
      submit: ['button[data-testid="beast-core-button"]', '.login-btn', 'button[type="submit"]']
    },
    // 如果跳到了mms后台，自动隐藏左侧商家菜单栏和顶部导航，只留聊天主体
    cleanCss: "",
    notes: '直连 mms.pinduoduo.com/chat-merchant/index.html 纯网页客服端，无需打开臃肿商家后台，支持多店铺独立Cookie多开。',
    sampleBuyers: [
      { name: '拼友_883920', avatar: '拼', time: '刚刚', msg: '老板，已经拼单成功了，什么时候能安排发货？急用！', orderNo: 'PDD-261014-994012', product: '家用抽纸整箱实惠装30包', price: '¥26.90' },
      { name: '桂林米粉爱好者', avatar: '粉', time: '4分钟前', msg: '买两箱有没有批发价？能发顺丰吗？', orderNo: '拼单前咨询', product: '特级原生木浆卷纸提装', price: '¥32.50' }
    ]
  },
  {
    id: 'taobao',
    hasCustomerService: false, // v11: 客服已删，仅保留订单
    orderUrl: 'https://trade.taobao.com/trade/itemlist/list_sold_items.htm',
    orderUnreadKeyword: ['待发货', '待发货订单', '未发货', '待处理发货'], // v11 Phase D: 订单页「待发货」数字关键词
    name: '淘宝·卖家中心',
    fullName: '淘宝/天猫千牛客服接待中心',
    shortName: '淘宝',
    color: '#FF5000',
    bgLight: 'rgba(255, 80, 0, 0.14)',
    iconText: '淘',
    badgeColor: '#FF5000',
    // 淘宝实时接待仅千牛客户端支持 → 主入口走 Windows 原生窗口嵌入「接待中心」
    url: 'https://trade.taobao.com/trade/itemlist/list_sold_items.htm', // v11: 淘宝主入口=订单(已卖出的宝贝)
    backupUrls: [
      { label: '淘宝旺旺单聊窗 (market.m.taobao.com)', url: 'https://market.m.taobao.com/app/im/chat/index.html' },
      { label: '千牛网页版卖家工作台 (myseller.taobao.com)', url: 'https://myseller.taobao.com/home.htm' }
    ],
    supportWin32Embed: true,
    win32ProcessName: 'AliWorkbench',
    win32TitleKeywords: ['接待中心', '客服工作台', '千牛接待', '旺旺'],
    unreadSelectors: [
      '.ww-unread-count',
      '.next-badge-count',
      '[class*="unread"]',
      '[class*="badge-count"]',
      '.im-unread'
    ],
    loginSelectors: {
      switchPasswordTab: ['.password-login-tab-item', 'a:contains("密码登录")'],
      username: ['#fm-login-id', 'input[name="fm-login-id"]', 'input[placeholder*="会员名/邮箱/手机号"]'],
      password: ['#fm-login-password', 'input[name="fm-login-password"]', 'input[type="password"]'],
      agreement: ['#fm-login-checkbox', 'input[type="checkbox"]'],
      submit: ['button.password-login', 'button[type="submit"]', '.fm-button']
    },
    // 纯净客服模式：在千牛网页端隐藏左侧商品/订单/数据后台菜单，聚焦客服消息区域
    cleanCss: "",
    notes: '淘宝官方未提供网页版客服收件箱，实时接待仅千牛客户端支持。本标签页把你电脑上已登录的千牛「接待中心」窗口直接嵌入进来，界面与原生千牛完全一致。切到本页自动嵌入并展开，切走自动隐藏，退出软件时自动还原为独立窗口（不会关闭千牛）。',
    sampleBuyers: [
      { name: 'tbNick_星辰大海', avatar: '星', time: '刚刚', msg: '亲，双11预售款现在拍下退差价吗？赠品有哪些？', orderNo: 'TB389201948271', product: '无线降噪蓝牙耳机Pro版', price: '¥299.00' },
      { name: '杭州湾小丸子', avatar: '丸', time: '5分钟前', msg: '快递显示签收了但是驿站没找到，麻烦帮我查下底单。', orderNo: 'TB389201102938', product: '磁吸快充移动电源10000mAh', price: '¥149.00' }
    ]
  },
  {
    id: 'weixin',
    hasCustomerService: true,
    orderUrl: 'https://store.weixin.qq.com/shop/order',
    orderUnreadKeyword: ['待发货', '待发货订单', '未发货', '待处理发货'], // v11 Phase D: 订单页「待发货」数字关键词
    name: '微信小店·客服',
    fullName: '微信小店 / 视频号小店客服工作台',
    shortName: '微信',
    color: '#07C160',
    bgLight: 'rgba(7, 193, 96, 0.14)',
    iconText: '微',
    badgeColor: '#07C160',
    // 微信小店独立客服工作台网页端
    url: 'https://store.weixin.qq.com/shop/kf',
    backupUrls: [
      { label: '微信小店网页客服 (store.weixin.qq.com/shop/kf)', url: 'https://store.weixin.qq.com/shop/kf' },
      { label: '腾讯微信客服网页版 (kf.weixin.qq.com)', url: 'https://kf.weixin.qq.com/' },
      { label: '视频号小店客服 (channels.weixin.qq.com/shop/kf)', url: 'https://channels.weixin.qq.com/shop/kf' },
    ],
    supportWin32Embed: true,
    win32ProcessName: 'WeChat',
    win32TitleKeywords: ['微信', 'WeChat'],
    unreadSelectors: [
      '.weui-badge',
      '[class*="unread-num"]',
      '[class*="unread"]',
      '.msg-badge',
      '.chat-item-unread'
    ],
    loginSelectors: {
      switchPasswordTab: [],
      username: ['input[name="account"]', 'input[type="text"]'],
      password: ['input[name="password"]', 'input[type="password"]'],
      agreement: ['input[type="checkbox"]'],
      submit: ['button[type="submit"]', '.btn_login']
    },
    // 纯净客服模式：隐藏微信小店左侧后台管理菜单（商品、订单、资金等），只保留客服接待全屏界面
    cleanCss: "",
    notes: '直连微信小店/视频号小店网页客服工作台，开启「纯净客服模式」后自动隐藏左侧店铺管理菜单，只保留全屏聊天窗。',
    sampleBuyers: [
      { name: '微信用户_清风徐来', avatar: '清', time: '刚刚', msg: '在视频号直播间看到这款礼盒，请问送礼有配套手提袋吗？', orderNo: 'WX2026101400921', product: '特级大红袍茶叶礼盒装250g', price: '¥368.00' },
      { name: 'Lina姐', avatar: 'L', time: '8分钟前', msg: '可以开公司增值税专票吗？抬头我发给您。', orderNo: 'WX2026101400315', product: '陈年普洱熟茶饼357g', price: '¥228.00' }
    ]
  },
  {
    id: 'kuaishou',
    hasCustomerService: true,
    orderUrl: 'https://s.kwaixiaodian.com/zone/order/order-list',
    orderUnreadKeyword: ['待发货', '待发货订单', '未发货', '待处理发货'], // v11 Phase D: 订单页「待发货」数字关键词
    name: '快手·小店客服',
    fullName: '快手小店客服IM工作台',
    shortName: '快手',
    color: '#FF4906',
    bgLight: 'rgba(255, 73, 6, 0.14)',
    iconText: '快',
    badgeColor: '#FF4906',
    // 快手小店独立IM客服工作台网址
    url: 'https://im.kwaixiaodian.com/',
    backupUrls: [
      { label: '快手小店独立IM客服工作台（纯客服推荐）', url: 'https://im.kwaixiaodian.com/' },
      { label: '快手小店客服调度台', url: 'https://s.kwaixiaodian.com/zone/im/dispatch' }
    ],
    supportWin32Embed: false,
    unreadSelectors: [
      '.ks-badge-count',
      '.unread-count',
      '[class*="unread"]',
      '[class*="badge"]',
      '.session-unread'
    ],
    loginSelectors: {
      switchPasswordTab: ['div:contains("密码登录")', 'span:contains("账号密码登录")'],
      username: ['input[placeholder*="手机号"]', 'input[placeholder*="账号"]', 'input[type="text"]'],
      password: ['input[type="password"]', 'input[placeholder*="密码"]'],
      agreement: ['input[type="checkbox"]'],
      submit: ['button[type="submit"]', '.login-button', '.ks-btn-primary']
    },
    cleanCss: "",
    notes: '直连 im.kwaixiaodian.com 独立客服系统，原版就是纯客服界面，响应极快，支持账密自动填充。',
    sampleBuyers: [
      { name: '老铁666_东北大哥', avatar: '铁', time: '刚刚', msg: '老妹儿，直播间拍的2号链接什么时候发？东北这边降温了等着穿呢！', orderNo: 'KS9920183746', product: '加厚防风鹅绒羽绒服男款', price: '¥399.00' },
      { name: '向日葵妈妈', avatar: '葵', time: '12分钟前', msg: '收到货试了一下袖子有点长，换小一码怎么操作？', orderNo: 'KS9920181120', product: '儿童轻便保暖羽绒马甲', price: '¥89.00' }
    ]
  },
  {
    id: 'xiaohongshu',
    hasCustomerService: false, // v11: 客服已删，仅保留订单
    orderUrl: 'https://qianfan.xiaohongshu.com/shop/order',
    orderUnreadKeyword: ['待发货', '待发货订单', '未发货', '待处理发货'], // v11 Phase D: 订单页「待发货」数字关键词
    name: '小红书·订单',
    fullName: '小红书千帆客服工作台',
    shortName: '小红书',
    color: '#FF2442',
    bgLight: 'rgba(255, 36, 66, 0.14)',
    iconText: '红',
    badgeColor: '#FF2442',
    // 小红书官方限制浏览器实时接待 → 主入口走 Windows 原生嵌入「千帆客服工作台」客户端
    url: 'https://qianfan.xiaohongshu.com/shop/order', // v11: 小红书主入口=订单
    backupUrls: [
      { label: '千帆客服数据页 (app-cs/gold-cs)', url: 'https://ark.xiaohongshu.com/app-cs/gold-cs' },
      { label: '千帆历史聊天记录查询 (cs-data/chat-manage)', url: 'https://ark.xiaohongshu.com/app-cs/cs-data/chat-manage' }
    ],
    supportWin32Embed: true,
    win32ProcessName: '千帆客服工作台',
    win32TitleKeywords: ['客服工作台', '千帆'],
    unreadSelectors: [
      '.d-badge-count',
      '.red-dot',
      '[class*="unread"]',
      '[class*="badge"]',
      '.chat-unread-num'
    ],
    loginSelectors: {
      switchPasswordTab: ['div:contains("密码登录")', 'span:contains("邮箱/手机号")'],
      username: ['input[placeholder*="手机号"]', 'input[placeholder*="邮箱"]', 'input[type="text"]'],
      password: ['input[type="password"]', 'input[placeholder*="密码"]'],
      agreement: ['input[type="checkbox"]'],
      submit: ['button[type="submit"]', '.d-button-primary', '[class*="login-btn"]']
    },
    // 纯净客服模式：隐藏千帆后台左侧导航菜单栏与顶部导航条，让客服聊天区100%铺满
    cleanCss: "",
    notes: '小红书官方限制浏览器端实时接待（app-customer/chat 路由不存在，登录也进不去接待页）。本标签页直接嵌入官方「千帆客服工作台」桌面端窗口；未登录的千帆数据页(gold-cs)与历史聊天记录查询(cs-data/chat-manage)保留在下拉里。',
    sampleBuyers: [
      { name: 'momo（穿搭博版）', avatar: 'M', time: '刚刚', msg: '姐妹！看笔记种草过来的，这款项链洗澡可以戴着吗？会掉色吗？', orderNo: 'XHS-20261014-772', product: 'S925纯银轻奢锁骨链女', price: '¥168.00' },
      { name: '芝士奶盖不加糖', avatar: '芝', time: '6分钟前', msg: '包装是礼盒装吗？想写一张手写贺卡可以帮忙代写吗~', orderNo: 'XHS-20261014-619', product: '复古巴洛克珍珠耳环', price: '¥138.00' }
    ]
  },
  {
    id: 'jd',
    hasCustomerService: true,
    orderUrl: 'https://shop.jd.com/oms/order-manage',
    orderUnreadKeyword: ['待发货', '待发货订单', '未发货', '待处理发货'], // v11 Phase D: 订单页「待发货」数字关键词
    name: '京东·咚咚客服',
    fullName: '京东咚咚商家网页版客服工作台',
    shortName: '京东',
    color: '#E1251B',
    bgLight: 'rgba(225, 37, 27, 0.14)',
    iconText: '京',
    badgeColor: '#E1251B',
    // 京东咚咚官方Web版客服工作台
    url: 'https://dongdong.jd.com/',
    backupUrls: [
      { label: '京东咚咚Web版客服工作台（推荐）', url: 'https://dongdong.jd.com/' },
      { label: '京麦商家客服中心入口', url: 'https://shop.jd.com/' }
    ],
    supportWin32Embed: true,
    win32ProcessName: 'JMWorkbench',
    win32TitleKeywords: ['京东咚咚', '咚咚工作台', '京麦'],
    unreadSelectors: [
      '.unread-num',
      '.dd-badge',
      '[class*="unread"]',
      '[class*="badge"]',
      '.msg-count'
    ],
    loginSelectors: {
      switchPasswordTab: ['.login-tab-r', 'a:contains("账户登录")'],
      username: ['#loginname', 'input[name="loginname"]', 'input[placeholder*="用户名/手机号/邮箱"]'],
      password: ['#nloginpwd', 'input[name="nloginpwd"]', 'input[type="password"]'],
      agreement: ['input[type="checkbox"]'],
      submit: ['#loginsubmit', 'a.btn-img', 'button[type="submit"]']
    },
    cleanCss: "",
    notes: '京东官方提供 dongdong.jd.com 咚咚Web版，无需安装臃肿京麦后台即可直接在网页内完成全流程客服接待。',
    sampleBuyers: [
      { name: 'jd_PLUS会员_王工', avatar: '王', time: '刚刚', msg: '你好，这台显示器支持Type-C一线连反向65W供电吗？带不带HDMI 2.1线？', orderNo: 'JD29384756102', product: '27英寸4K IPS设计师专业显示器', price: '¥1,699.00' },
      { name: '北京朝阳企业采购', avatar: '企', time: '15分钟前', msg: '我们公司采购10台，请问什么时候能开具13%增值税专用发票？', orderNo: 'JD29384711092', product: '人体工学无线机械键盘', price: '¥459.00' }
    ]
  },
  {
    id: 'xianyu',
    hasCustomerService: true,
    orderUrl: '', // 闲鱼无商家订单后台 → 仪表盘标「暂不支持」
    orderUnsupported: true,
    name: '闲鱼·网页版IM',
    fullName: '闲鱼官方网页版消息接待中心',
    shortName: '闲鱼',
    color: '#FFAA00',
    bgLight: 'rgba(255, 170, 0, 0.16)',
    iconText: '鱼',
    badgeColor: '#FF9900',
    // 闲鱼2024-2026最新官方网页版 goofish.com 消息页
    url: 'https://www.goofish.com/im',
    backupUrls: [
      { label: '闲鱼官方网页版IM聊天页（goofish.com/im）', url: 'https://www.goofish.com/im' },
      { label: '闲鱼官方网页版首页', url: 'https://www.goofish.com/' }
    ],
    supportWin32Embed: false,
    unreadSelectors: [
      '[class*="unread"]',
      '[class*="badge"]',
      '.im-unread-num',
      '[class*="conversation-item"] [class*="count"]'
    ],
    loginSelectors: {
      switchPasswordTab: ['.password-login-tab-item', 'a:contains("密码登录")'],
      username: ['#fm-login-id', 'input[name="fm-login-id"]', 'input[placeholder*="手机号/用户名"]'],
      password: ['#fm-login-password', 'input[name="fm-login-password"]', 'input[type="password"]'],
      agreement: ['#fm-login-checkbox', 'input[type="checkbox"]'],
      submit: ['button.password-login', 'button[type="submit"]']
    },
    // 纯净客服模式：在 goofish.com 中自动隐藏顶部闲鱼商品搜索栏、底部备案栏、首页瀑布流，把IM聊天框放大为100%全屏！
    cleanCss: "",
    notes: '基于阿里官方推出的闲鱼网页版 goofish.com/im，通过CSS净化自动剔除闲鱼首页逛街瀑布流，把聊天窗口100%全屏化。',
    sampleBuyers: [
      { name: '数码淘客阿杰', avatar: '杰', time: '刚刚', msg: '哥们，这台镜头成色怎么样？镜片有没有霉斑或者划痕？诚心要能少50包邮吗？', orderNo: 'XY-宝贝咨询', product: '索尼 FE 50mm F1.8 全画幅定焦镜头', price: '¥950.00' },
      { name: '大学生出闲置', avatar: '学', time: '9分钟前', msg: '现在拍下今天能发顺丰到付吗？我周末急着拍照用~', orderNo: 'XY-待付款', product: '富士相机复古真皮背带', price: '¥88.00' }
    ]
  }
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PLATFORMS };
}
if (typeof window !== 'undefined') {
  window.PLATFORMS = PLATFORMS;
}
