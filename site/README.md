# relaymic.com 落地页

Remote Visio 的项目主页：讲清楚它补的是哪个空档，然后把人送到 GitHub。
静态页 + 一个只做 www 收敛的 Worker，跑在 Cloudflare Workers 上，零成本。

## 结构

```
public/            静态资源，整站 ~85KB（含自托管字体）
  index.html       首页
  privacy.html     隐私政策
  terms.html       条款
  es/              西语版三页，共用同一套 CSS/JS
  _headers         安全响应头与缓存策略
  assets/
    site.css       全部样式
    signal.js      首屏信号面板（纯展示，不发任何请求）
    fonts/         Archivo + IBM Plex Mono（自托管，见下）
src/index.js       Worker：www → 根域 301，其余交给静态资源
tools/og-*         OG 图的渲染源，不参与部署
```

**字体自托管不是洁癖**：引用 Google Fonts CDN 会把访客 IP 送给第三方，欧盟已有判例。
`_headers` 里的 CSP 也因此能收得很紧 —— 页面不加载任何外部域。

## 开发与部署

```sh
npm install
npm run dev      # http://localhost:8788
npm run deploy
```

**已上线**：https://relaymic.com 。Worker 名 `remotevisio-site`，自定义域在 `routes` 里
声明，`wrangler deploy` 会一并接好，不用去控制台点。

`www.relaymic.com` 也绑了，但由 Worker 301 到根域 —— 两个域都能打开会把外链和搜索
权重劈成两半，而 canonical 指的是根域。

## 这个站收集什么：GA4 访问统计，仅此而已

Measurement ID `G-RMG8MNGGZQ`（GA4 property 552752895）。三语九页都挂了，
初始化代码在 `assets/ga.js` —— 单独成文件而不是内联，是为了 CSP 继续不开
`unsafe-inline`。`_headers` 里的 CSP 已按 GA4 的官方域名清单放行
（script/img/connect 三个指令，`*.googletagmanager.com` / `*.google-analytics.com` /
`*.analytics.google.com`）。

**装分析动了三处，缺一处政策就是假的**：CSP 放行、三语隐私政策改写实
（「什么都不收集」→「收访问统计，会设 Cookie」）、这份 README。隐私政策里
还特意写了"这段话是因为加了它才出现的，改动在公开 git 历史里" —— 兑现当初
"政策变更先改页面、git 可查"的承诺。

表单、邮箱名单、数据库仍然没有 —— 那条链路在转开源时整个拆了，见 git 历史。

## 西语版

`/es/`、`/es/privacy`、`/es/terms`，共用 `site.css` 和 `signal.js`，DOM 与英文版
逐节对应，改版式时两边一起改。西语文本比英文长 15–25%，改完值得在 390px 宽下
看一眼表格和 H1。

`hreflang` 三页互指，`sitemap.xml` 里六条 URL 都在。

## 那个自动注入的 beacon（记下来，免得下次再查一遍）

Cloudflare 会给**每个新建的代理 zone** 自动建一个 Web Analytics 站点并开
`auto_install`，往 HTML 里塞 `static.cloudflareinsights.com` 的 beacon。
本站 CSP 是 `script-src 'self'`，于是它被拦下 —— 数据一条收不到，每个访客还白发
一个被拒请求、console 留一条红色报错。

排查时有三个坑：

1. **纯 curl 看不见它**。注入只对"像浏览器"的请求做，要带上 UA 和 `Accept: text/html`
2. **zone 页面里的「真实用户度量 (RUM)」显示未启用**，看着像没开，但注入照旧
3. **beacon 里的 `token` 不是 site_tag**，要用 `site_token` 去 `rum/site_info/list` 反查

**别指望从 Cloudflare 那边关掉它。** `auto_install: false` 和暂停注入规则两条都试过，
都确认落库、没被回滚，边缘等了 12 分钟照样注入。

**真正解决它的是 `_headers` 里给 HTML 加的 `no-transform`**（见该文件的注释）。
标准指令，禁止中间代理改动响应体，Cloudflare 据此关掉对 HTML 的全部后处理。
实测 brotli 压缩不受影响。加完还要**清一次 zone 缓存**，否则边缘上那份加
no-transform 之前的旧 HTML 还在，带随机查询参数也照样命中。

## 重新生成 OG 图

```sh
cp tools/og-source.html public/ && cp tools/og.css tools/og.js public/assets/
npm run dev
# 浏览器视口设成 1200×630 打开 /og-source.html，截图存为 public/assets/og.png
sips -Z 1200 public/assets/og.png --out public/assets/og.png
rm public/og-source.html public/assets/og.css public/assets/og.js
```

## 历史

这个站最初是为付费投放测试建的（收邮箱、测转化率）。测试的完整经过和结论在
`docs/google-ads.md`：**三天、不到 $10，用三个独立来源确认了搜索广告触达不了这个
产品的用户**，于是项目转为纯开源。那份文档留着，方法本身比这个产品更值得复用。
