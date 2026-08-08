# SubtitleMate 技术路线对比：模拟点击 UI vs 操作 YouTube Player 内部对象

> 文档生成时间：2026-08-09
> 背景：用户反馈 Reload 扩展后视频仍显示英文字幕，需要评估当前方案（方案1）与替代方案（方案2）的可行性，确认明天执行方向。

---

## 一句话结论

**方案2（操作 YouTube Player 内部对象）是当前已经落地且应该继续深化的路线。** 方案1（模拟点击 UI）已经被之前的迭代证明不稳定，已废弃。明天的优化重点不是"选哪个方案"，而是在方案2的基础上：① 删除无效的"应用"按钮和"记住语言偏好"复选框；② 放宽翻译成功判定；③ 增加二次确认 fallback。

---

## 方案1：模拟点击 YouTube UI

### 原理
扩展在页面里自动执行一系列用户操作：

```
点击 CC 按钮
→ 点击设置齿轮
→ 点击"字幕"
→ 点击"自动翻译"
→ 选择中文
```

### 优点

1. **最接近用户真实操作路径**：YouTube 官方 UI 变了，操作逻辑也会跟着变，理论上"人怎么做，扩展就怎么做"。
2. **不需要研究 YouTube 内部 API**：不需要读 `ytplayer`、`playerResponse`、`captionTracks` 等私有对象。
3. **开发简单**：纯 DOM 查询 + 点击事件，初期验证快。

### 缺点

1. **极其不稳定（致命）**
   - YouTube 是 SPA，切换视频时页面不重新加载，DOM 会复用或重建。
   - 按钮是动态生成的，class 名会变化。
   - 不同账号、不同地区、不同 A/B 测试版本的 UI 可能不一样。
   - 菜单弹出是异步的，点击间隔很难把握。
2. **容易点到错误的元素**：翻译菜单嵌套层级多，选择器稍微变化就失效。
3. **与用户操作冲突**：如果用户同时手动点设置，容易互相覆盖。
4. **难以验证是否成功**：只能通过观察字幕是否出现来判断，没有可靠的状态回读。

### 当前项目状态

**该方案已在 2026-08-09 的迭代中被废弃。** 当前 `content/content.js` 中已经不再使用 `applyUiFallback`、`openCcPanel`、`clickMenuItemAndWait` 等模拟点击逻辑，改为方案2的内部 API 路线。

### 可行性评估

| 维度 | 评分 | 说明 |
|------|------|------|
| 稳定性 | ★☆☆☆☆ | 极易因 YouTube UI 变化失效 |
| 开发成本 | ★★★★☆ | 初期快，后期维护成本高 |
| 可维护性 | ★☆☆☆☆ | 需要持续跟进 UI 变化 |
| 成功率 | ★★☆☆☆ | 部分视频能成功，但极不可靠 |
| 推荐度 | ★☆☆☆☆ | **不建议继续使用** |

---

## 方案2：操作 YouTube Player 内部对象

### 原理
YouTube 页面上的播放器实际上暴露了一个内部对象，可以通过 `window.yt.player.getPlayerByElement(video)` 或 `document.getElementById('movie_player')` 获取到 player 实例。这个 player 提供了 `setOption` / `getOption` 方法，可以直接操作字幕配置：

```javascript
// 获取 player 实例
const player = window.yt.player.getPlayerByElement(video);

// 获取当前可用的字幕轨道
const trackList = player.getOption('captions', 'tracklist');

// 选择一个基底字幕轨，并同时指定翻译目标语言
player.setOption('captions', 'track', {
  ...baseTrack,                          // 例如 en 原生字幕轨
  translationLanguage: { languageCode: 'zh-Hans' }
});
```

### 优点

1. **不依赖按钮位置**：不需要查 DOM、不需要等菜单渲染。
2. **稳定很多**：直接调用播放器内部方法，绕开 UI 层的不确定性。
3. **像专业扩展做法**：类似 YouTube 双语字幕类扩展的常规实现方式。
4. **可回读状态**：可以通过 `getOption('captions', 'track')` 验证当前是否真的开启了翻译。
5. **SPA 切换友好**：同一个 player 实例在视频切换后仍然可用，配合 `yt-navigate-finish` 事件即可重置状态。

### 缺点

1. **YouTube 没有公开 API**：`setOption` / `getOption` 是内部方法，未来可能变化。
2. **需要逆向研究**：要搞清楚 `track` 对象的结构、哪些字段必须、哪些可省、翻译语言如何嵌套。
3. **不同视频的字幕轨不同**：有的视频只有自动生成字幕，有的只有翻译轨，有的完全没有字幕，需要做兜底。
4. **翻译目标语言的 code 不统一**：YouTube 可能用 `zh-Hans`、`zh-CN`、`zh` 等不同 code，需要做映射和 fallback。

### 当前项目状态

**该方案已在 2026-08-09 落地。** 当前 `content/content.js` 的核心逻辑已经是方案2：

- 通过 `window.yt.player.getPlayerByElement(video)` 获取 player。
- 选择非翻译的基底轨（优先 `en/asr` 原生轨）。
- 调用 `player.setOption('captions', 'track', { ...baseTrack, translationLanguage })` 一次性设置。
- 通过 `getOption('captions', 'track')` 和检查 `.ytp-caption-segment` 验证是否成功。

### 可行性评估

| 维度 | 评分 | 说明 |
|------|------|------|
| 稳定性 | ★★★★☆ | 明显优于方案1，但仍受 YouTube 内部变更影响 |
| 开发成本 | ★★★☆☆ | 初期需要研究内部 API，但一旦跑通维护成本低 |
| 可维护性 | ★★★★☆ | 逻辑集中，不随 UI 变化 |
| 成功率 | ★★★★☆ | 大多数有可用字幕的视频可以成功 |
| 推荐度 | ★★★★★ | **推荐继续走这条路线** |

---

## 为什么现在"还是不行"：方案2 仍需优化的点

方案2 虽然方向正确，但当前实现有几个导致"假失败"的问题：

### 1. `verifyApplied` 验证条件过严

当前代码要求 `getOption('captions', 'track')` 返回的对象里必须存在 `translationLanguage`，否则认为失败。但 YouTube player 在成功设置后，**经常不返回嵌套的 `translationLanguage` 字段**，导致视觉上字幕其实已经翻译，但代码判定失败，从而反复重试。

### 2. 缺少"设置后再单独补一次 translationLanguage"的 fallback

虽然正确的做法是 `setOption('captions', 'track', { ...baseTrack, translationLanguage })` 一次性设置，但在某些情况下，播放器可能需要额外一次 `setOption('captions', 'translationLanguage', { languageCode })` 才能真正生效。当前代码缺少这个 fallback。

### 3. "应用"按钮造成误解

popup 里任何改动都会实时保存并自动触发 content.js 重跑，"应用"按钮的功能已经和自动保存重复，反而让用户误以为"没点应用就不生效"。

### 4. "记住语言偏好"复选框是无效控件

代码中没有任何地方读取 `sm_rememberLang`，勾不勾都不影响行为，应该删除。

---

## 明天的执行建议

不需要再回退到方案1，而是在方案2上做以下优化：

### UI 层

1. **删除"应用"按钮**
2. **删除"记住语言偏好"复选框**
3. **popup 打开时自动对当前 YouTube 标签页触发一次强制应用**
4. **在 popup 底部显示状态提示**："已应用到当前视频" / "当前视频暂无可用字幕"

### content.js 逻辑层

1. **放宽 `verifyApplied` 判定**
   - 不强制要求 `track.translationLanguage` 存在。
   - 改为：只要 `.ytp-caption-segment` 出现且字幕正在显示，即判定成功。
   - 对中文目标语言做宽松匹配：`zh-Hans` / `zh-CN` / `zh` 都算命中。

2. **`applyApi` 增加二次确认 fallback**
   - 先按现有逻辑设置 `track + translationLanguage`。
   - 等待 300ms 后重读 `getOption('captions', 'track')`。
   - 如果翻译未生效，单独再调一次 `player.setOption('captions', 'translationLanguage', { languageCode: target })`。

3. **新增 `SM_FORCE_APPLY` 消息类型**
   - 供 popup 打开时调用，忽略 `applied` 状态强制重跑。

4. **清理 `shared/shared.js` 中的 `REMEMBER_LANG` 相关文案和存储 key**

### 涉及文件

- `popup/popup.html`
- `popup/popup.js`
- `popup/popup.css`
- `content/content.js`
- `shared/shared.js`

---

## 最终结论

**选方案2，继续优化。** 方案1已经证明不稳定且已被废弃。当前的核心问题不是"路线错了"，而是方案2的验证逻辑和 fallback 还不够健壮，加上 UI 上有两个无效控件在干扰用户判断。明天按上述建议执行即可。

---

## 参考

- 当前 `content/content.js` 中 `applyApi` / `verifyApplied` 实现
- 当前 `popup/popup.html` / `popup/popup.js` 控件结构
- YouTube Player API 内部方法：`getOption('captions', 'tracklist')`、`setOption('captions', 'track')`、`getOption('captions', 'track')`
