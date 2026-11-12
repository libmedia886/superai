# server 页面效果图

server 本体、登录与功能模块页面的效果图，实现时以此对照。桌面为 1440×900，手机为 390×844，每页有夜市与晨市两张；手机的登录方式、电脑详情中的插件、智能体动态与完整活动记录比一屏长，截取滚动后的整页，分别为 390×1010、390×1130、390×1040 与 390×1250。

## 页面

| 页面 | 夜市 | 晨市 | 源文件 |
| --- | --- | --- | --- |
| 登录：账号密码 | [夜市](screens/desktop/login-night.png) | [晨市](screens/desktop/login-day.png) | `src/login.html?view=password` |
| 登录：第三方登录 | [夜市](screens/desktop/login-third-night.png) | [晨市](screens/desktop/login-third-day.png) | `src/login.html` |
| 总览 | [夜市](screens/desktop/overview-night.png) | [晨市](screens/desktop/overview-day.png) | `src/overview.html` |
| 智能体：列表 | [夜市](screens/desktop/agents-night.png) | [晨市](screens/desktop/agents-day.png) | `src/agents.html` |
| 智能体：行菜单 | [夜市](screens/desktop/agents-menu-night.png) | [晨市](screens/desktop/agents-menu-day.png) | `src/agents.html?view=menu` |
| 智能体：删除 | [夜市](screens/desktop/agents-delete-night.png) | [晨市](screens/desktop/agents-delete-day.png) | `src/agents.html?view=delete` |
| 智能体：动态（第 14 阶段，活动模块） | [夜市](screens/desktop/agent-night.png) | [晨市](screens/desktop/agent-day.png) | `src/agent.html` |
| 智能体：完整活动记录（第 14 阶段） | [夜市](screens/desktop/agent-activity-log-night.png) | [晨市](screens/desktop/agent-activity-log-day.png) | `src/agent.html?tab=activity-log` |
| 智能体：会话（第 14 阶段） | [夜市](screens/desktop/agent-chats-night.png) | [晨市](screens/desktop/agent-chats-day.png) | `src/agent.html?tab=chats` |
| 智能体：工作区 | [夜市](screens/desktop/agent-workspace-night.png) | [晨市](screens/desktop/agent-workspace-day.png) | `src/agent.html?tab=workspace` |
| 智能体：查看 Markdown 文件 | [夜市](screens/desktop/agent-file-night.png) | [晨市](screens/desktop/agent-file-day.png) | `src/agent.html?tab=workspace&file=md` |
| 智能体：查看代码文件（按类型着色） | [夜市](screens/desktop/agent-file-text-night.png) | [晨市](screens/desktop/agent-file-text-day.png) | `src/agent.html?tab=workspace&file=text` |
| 智能体：技能 | [夜市](screens/desktop/agent-skills-night.png) | [晨市](screens/desktop/agent-skills-day.png) | `src/agent.html?tab=skills` |
| 智能体：配置 | [夜市](screens/desktop/agent-config-night.png) | [晨市](screens/desktop/agent-config-day.png) | `src/agent.html?tab=config` |
| 智能体：配置中编辑渠道 | [夜市](screens/desktop/agent-config-edit-night.png) | [晨市](screens/desktop/agent-config-edit-day.png) | `src/agent.html?tab=config&edit=lark` |
| 智能体：分享 | [夜市](screens/desktop/agent-share-night.png) | [晨市](screens/desktop/agent-share-day.png) | `src/agent.html?tab=share` |
| 会话 | [夜市](screens/desktop/chats-night.png) | [晨市](screens/desktop/chats-day.png) | `src/chats.html` |
| 会话：不再回复的确认（第 14 阶段） | [夜市](screens/desktop/chats-revoke-night.png) | [晨市](screens/desktop/chats-revoke-day.png) | `src/chats.html?view=revoke` |
| 会话：新联系人的审批（第 14 阶段） | [夜市](screens/desktop/chats-contacts-night.png) | [晨市](screens/desktop/chats-contacts-day.png) | `src/chats.html?view=contacts` |
| 会话：搜索消息（第 14 阶段） | [夜市](screens/desktop/chats-search-night.png) | [晨市](screens/desktop/chats-search-day.png) | `src/chats.html?view=search` |
| 新建智能体：基本信息 | [夜市](screens/desktop/new-agent-1-night.png) | [晨市](screens/desktop/new-agent-1-day.png) | `src/new-agent.html?step=1` |
| 新建智能体：渠道 | [夜市](screens/desktop/new-agent-night.png) | [晨市](screens/desktop/new-agent-day.png) | `src/new-agent.html` |
| 新建智能体：运行时 | [夜市](screens/desktop/new-agent-3-night.png) | [晨市](screens/desktop/new-agent-3-day.png) | `src/new-agent.html?step=3` |
| 新建智能体：确认 | [夜市](screens/desktop/new-agent-4-night.png) | [晨市](screens/desktop/new-agent-4-day.png) | `src/new-agent.html?step=4` |
| 电脑：接入新电脑 | [夜市](screens/desktop/computers-night.png) | [晨市](screens/desktop/computers-day.png) | `src/computers.html` |
| 电脑：列表 | [夜市](screens/desktop/computers-list-night.png) | [晨市](screens/desktop/computers-list-day.png) | `src/computers.html?view=list` |
| 电脑：行菜单 | [夜市](screens/desktop/computers-menu-night.png) | [晨市](screens/desktop/computers-menu-day.png) | `src/computers.html?view=menu` |
| 电脑：分享 | [夜市](screens/desktop/computers-share-night.png) | [晨市](screens/desktop/computers-share-day.png) | `src/computers.html?view=share` |
| 电脑：删除 | [夜市](screens/desktop/computers-delete-night.png) | [晨市](screens/desktop/computers-delete-day.png) | `src/computers.html?view=delete` |
| 电脑：详情 | [夜市](screens/desktop/computers-detail-night.png) | [晨市](screens/desktop/computers-detail-day.png) | `src/computers.html?view=detail` |
| 电脑：详情中的插件（第 15 阶段，市场模块） | [夜市](screens/desktop/computers-detail-plugins-night.png) | [晨市](screens/desktop/computers-detail-plugins-day.png) | `src/computers.html?view=detail-plugins` |
| 设置：登录方式 | [夜市](screens/desktop/settings-login-night.png) | [晨市](screens/desktop/settings-login-day.png) | `src/settings-login.html` |
| 设置：登录方式，保存后 | [夜市](screens/desktop/settings-login-set-night.png) | [晨市](screens/desktop/settings-login-set-day.png) | `src/settings-login.html?state=set` |
| 手机：登录 | [夜市](screens/phone/login-night.png) | [晨市](screens/phone/login-day.png) | `src/mobile.html?screen=login` |
| 手机：第三方登录 | [夜市](screens/phone/login-third-night.png) | [晨市](screens/phone/login-third-day.png) | `src/mobile.html?screen=login-third` |
| 手机：总览 | [夜市](screens/phone/overview-night.png) | [晨市](screens/phone/overview-day.png) | `src/mobile.html?screen=overview` |
| 手机：设置 | [夜市](screens/phone/settings-night.png) | [晨市](screens/phone/settings-day.png) | `src/mobile.html?screen=settings` |
| 手机：外观 | [夜市](screens/phone/appearance-night.png) | [晨市](screens/phone/appearance-day.png) | `src/mobile.html?screen=appearance` |
| 手机：登录方式 | [夜市](screens/phone/login-methods-night.png) | [晨市](screens/phone/login-methods-day.png) | `src/mobile.html?screen=login-methods` |
| 手机：侧边栏组件与徽标 | [夜市](screens/phone/working-night.png) | [晨市](screens/phone/working-day.png) | `src/mobile.html?screen=working` |
| 手机：电脑 | [夜市](screens/phone/computers-night.png) | [晨市](screens/phone/computers-day.png) | `src/mobile.html?screen=computers` |
| 手机：电脑详情 | [夜市](screens/phone/computer-night.png) | [晨市](screens/phone/computer-day.png) | `src/mobile.html?screen=computer` |
| 手机：分享电脑 | [夜市](screens/phone/computer-share-night.png) | [晨市](screens/phone/computer-share-day.png) | `src/mobile.html?screen=computer-share` |
| 手机：删除电脑 | [夜市](screens/phone/computer-delete-night.png) | [晨市](screens/phone/computer-delete-day.png) | `src/mobile.html?screen=computer-delete` |
| 手机：电脑详情中的插件（第 15 阶段，市场模块） | [夜市](screens/phone/computer-plugins-night.png) | [晨市](screens/phone/computer-plugins-day.png) | `src/mobile.html?screen=computer-plugins` |
| 手机：智能体 | [夜市](screens/phone/agents-night.png) | [晨市](screens/phone/agents-day.png) | `src/mobile.html?screen=agents` |
| 手机：分享智能体 | [夜市](screens/phone/agent-share-night.png) | [晨市](screens/phone/agent-share-day.png) | `src/mobile.html?screen=agent-share` |
| 手机：删除智能体 | [夜市](screens/phone/agent-delete-night.png) | [晨市](screens/phone/agent-delete-day.png) | `src/mobile.html?screen=agent-delete` |
| 手机：智能体动态（第 14 阶段） | [夜市](screens/phone/agent-night.png) | [晨市](screens/phone/agent-day.png) | `src/mobile.html?screen=agent` |
| 手机：完整活动记录（第 14 阶段） | [夜市](screens/phone/activity-log-night.png) | [晨市](screens/phone/activity-log-day.png) | `src/mobile.html?screen=activity-log` |
| 手机：智能体工作区 | [夜市](screens/phone/agent-workspace-night.png) | [晨市](screens/phone/agent-workspace-day.png) | `src/mobile.html?screen=agent-workspace` |
| 手机：查看工作区文件 | [夜市](screens/phone/agent-file-night.png) | [晨市](screens/phone/agent-file-day.png) | `src/mobile.html?screen=agent-file` |
| 手机：智能体技能 | [夜市](screens/phone/agent-skills-night.png) | [晨市](screens/phone/agent-skills-day.png) | `src/mobile.html?screen=agent-skills` |
| 手机：智能体配置 | [夜市](screens/phone/agent-config-night.png) | [晨市](screens/phone/agent-config-day.png) | `src/mobile.html?screen=agent-config` |
| 手机：智能体配置中编辑渠道 | [夜市](screens/phone/agent-config-edit-night.png) | [晨市](screens/phone/agent-config-edit-day.png) | `src/mobile.html?screen=agent-config-edit` |
| 手机：会话（第 14 阶段） | [夜市](screens/phone/chats-night.png) | [晨市](screens/phone/chats-day.png) | `src/mobile.html?screen=chats` |
| 手机：新联系人（第 14 阶段） | [夜市](screens/phone/contacts-night.png) | [晨市](screens/phone/contacts-day.png) | `src/mobile.html?screen=contacts` |
| 手机：新联系人的审批（第 14 阶段） | [夜市](screens/phone/review-night.png) | [晨市](screens/phone/review-day.png) | `src/mobile.html?screen=review` |
| 手机：会话内容（第 14 阶段） | [夜市](screens/phone/chat-night.png) | [晨市](screens/phone/chat-day.png) | `src/mobile.html?screen=chat` |
| 手机：会话信息（第 14 阶段） | [夜市](screens/phone/chat-info-night.png) | [晨市](screens/phone/chat-info-day.png) | `src/mobile.html?screen=chat-info` |
| 手机：不再回复的确认（第 14 阶段） | [夜市](screens/phone/chat-revoke-night.png) | [晨市](screens/phone/chat-revoke-day.png) | `src/mobile.html?screen=chat-revoke` |
| 手机：搜索消息（第 14 阶段） | [夜市](screens/phone/search-night.png) | [晨市](screens/phone/search-day.png) | `src/mobile.html?screen=search` |
| 手机：新建智能体：基本信息 | [夜市](screens/phone/new-agent-1-night.png) | [晨市](screens/phone/new-agent-1-day.png) | `src/mobile.html?screen=new-agent-1` |
| 手机：新建智能体：渠道 | [夜市](screens/phone/new-agent-2-night.png) | [晨市](screens/phone/new-agent-2-day.png) | `src/mobile.html?screen=new-agent-2` |
| 手机：新建智能体：运行时 | [夜市](screens/phone/new-agent-3-night.png) | [晨市](screens/phone/new-agent-3-day.png) | `src/mobile.html?screen=new-agent-3` |
| 手机：新建智能体：确认 | [夜市](screens/phone/new-agent-4-night.png) | [晨市](screens/phone/new-agent-4-day.png) | `src/mobile.html?screen=new-agent-4` |

晨市在地址后加 `theme=day`。

## 源文件

- `tokens.css` 是定稿设计的 token 与组件；`flat.css` 把其中的渐变与发光改为纯色，实现以覆盖后的样子为准。
- `scene.css` 是登录页插画的配色：`--scene-*` 由主题给出，灯笼、棚子与货物取主题的五种主色，暗面与亮面由它们混出。
- `scene.py` 按曲线生成插画的 SVG；修改后运行 `python3 src/build.py`，写回 `login.html` 与 `mobile.html`。
- `awning.js` 画摊位卡片顶上的棚子，与插画中的棚子同一画法；`tents.js` 与 `ui.js` 中的 MARK 是品牌标识。
- `logos.js` 是渠道、运行时与包来源（PyPI、git）的品牌图标，来源与许可写在各条目中。
- `render.sh 页面 输出 [宽 高]` 以 headless Chromium 截取 1 倍图，手机页传 `390 844`。页面从 Google Fonts 取字体，渲染时需要联网。
