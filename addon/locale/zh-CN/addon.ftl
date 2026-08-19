startup-begin = 引用计数正在加载
startup-finish = 引用计数已就绪
startup-progress = [{ $percent }%] { $message }
menuitem-update-citation-tallies =
    .label = 更新引用计数
menuitem-retally-outdated-citations =
    .label = 重新统计过期引用
prefs-title = 引用计数
prefs-table-title = 标题
prefs-table-detail = 详情

# Progress window messages
progress-getting-citation-tallies = 正在获取引用计数
progress-no-valid-items = 未选择有效的项目来更新引用计数。
progress-items-updated = 已为 { $count } 个项目更新了引用计数。
progress-item-counter = 项目 { $current } / { $total }

# Auto-update messages
auto-update-title = { $addonName } - 自动更新中 (点击隐藏)
auto-update-updating-outdated = 正在更新 { $count } 个过期引用...
auto-update-updating-item = 正在更新项目 { $current } / { $total }
auto-update-connection-retry = 连接问题，正在重试... ({ $current }/{ $max })
auto-update-stopped = 自动更新已停止：{ $error }
auto-update-completed = 自动更新完成：{ $updated }/{ $total } 个项目已更新

# Database display names
database-crossref = Crossref
database-inspire = INSPIRE
database-semanticscholar = SemanticScholar

# Semantic Scholar API key
semantic-scholar-key-rejected = Semantic Scholar 拒绝了您的 API 密钥。引用计数已停止使用它，稍后会自动重试。
semantic-scholar-unavailable = Semantic Scholar 不可用，已被关闭。其他引用数据库仍可正常使用。

# Column and tooltip
column-citations = 引用
tooltip-citation-tallies = { $displayName }：{ $count }