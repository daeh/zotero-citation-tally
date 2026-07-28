# XUL widgets (button, radio, menuitem) render from their `label` attribute and
# keep their indicator or arrow in internal content. Localize them with an
# attribute — a plain value makes Fluent write textContent, wiping that content.

# Citation databases
pref-citation-databases = 引用数据库（按此顺序显示）
pref-database-instructions = 输入1-3个数据库，用逗号分隔
pref-database-options-label = 可选值：
pref-database-field =
    .placeholder = crossref, semanticscholar
pref-validate-button =
    .label = 验证
pref-database-duplicate = 发现重复的数据库
pref-database-invalid = 无效的数据库：{ $databases }
pref-database-count = 请输入1-3个数据库
pref-database-valid = ✓ 数据库配置有效

# Automatic updates
pref-fetch-on-add = 为新条目获取引用
pref-fetch-on-add-enabled =
    .label = 添加条目时获取引用计数
pref-fetch-on-add-disabled =
    .label = 不为新条目获取引用计数
pref-auto-update-settings = 自动更新
pref-auto-update-description = 自动更新库中条目的引用计数
pref-auto-update-never =
    .label = 从不自动更新
pref-auto-update-startup =
    .label = 在启动时更新过期引用
pref-auto-update-cutoff-label = 在以下时间后认为引用过期：
pref-auto-update-cutoff-3 =
    .label = 3个月
pref-auto-update-cutoff-6 =
    .label = 6个月
pref-auto-update-cutoff-12 =
    .label = 12个月
pref-auto-update-cutoff-24 =
    .label = 24个月

# Display
pref-color-settings = 显示选项
pref-color-description = 为列中的引用计数着色
pref-use-colors =
    .label = 为不同数据库使用颜色
pref-no-colors =
    .label = 不使用颜色显示

# API keys
pref-apikeys-heading = API 密钥
pref-apikey-intro = 可选，但建议填写。若不设置密钥，请求将与其他所有匿名客户端共享 Semantic Scholar 的匿名配额，查询会更慢，也更不可靠。
pref-apikey-storage = 以明文保存在 Zotero 的首选项中。
pref-apikey-label = Semantic Scholar
pref-apikey-field =
    .placeholder = s2k-***
pref-apikey-valid = ✓ API 密钥有效
pref-apikey-invalid = ✗ Semantic Scholar 拒绝了此密钥
pref-apikey-indeterminate = 目前无法检查该密钥，请重试。
pref-apikey-error = Semantic Scholar 返回了意外错误
pref-apikey-empty = 未设置密钥（使用匿名访问）
pref-apikey-checking = 正在检查…
pref-apikey-unavailable = Semantic Scholar 在此处不可用
pref-apikey-cleaned = 已从粘贴的密钥中移除不可见字符（{ $characters }）。

pref-help = { $name } [构建 { $version } { $time }]
