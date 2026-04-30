# Mouse Tail Rainbow Color Modes Implementation Plan

## Goal
为 Precise 渲染模式添加 3 种彩虹颜色模式，与原有纯色模式共 4 种。

## Color Modes

### 1. Solid (`solid`)
- 原有颜色模式
- 轨迹起始点为用户配置颜色，结束点完全透明
- 使用现有 `color` + `alpha` 设置

### 2. Fixed-Length Rainbow (`rainbow-fixed`)
- 用户配置多个无透明度颜色 + 像素长度
- 轨迹起始点为第一个配置颜色，随轨迹方向距离渐变到第二个，依次向下
- 尾部颜色（最后一个）不需要配置距离（无限距离）
- 按累计几何距离（像素）着色

### 3. Ratio Rainbow (`rainbow-ratio`)
- 用户配置多个无透明度颜色 + 比例值（正数，自动归一化）
- 按占总轨迹长度的比例对轨迹进行渐变着色
- 比例值之和不需要等于 1.0，内部自动归一化

### 4. Time-Based Rainbow (`rainbow-time`)
- 用户配置多个无透明度颜色 + 滞留时间长度（毫秒）
- 颜色在点位加入数组时即绑定
- 基于绝对时间取模循环：配置定义一个完整周期，随时间循环往复
- 落在两个色标之间时，按时间比例混合前后颜色
- 效果：轨迹呈现持续流动的彩虹效果（极光/流光）

---

## Files to Modify

### 1. `schemas/org.gnome.shell.extensions.mouse-tail.gschema.xml`
新增 4 个配置键：
- `color-mode` (string): 颜色模式选择
- `rainbow-fixed-config` (string): 定长彩虹配置
- `rainbow-ratio-config` (string): 比例彩虹配置  
- `rainbow-time-config` (string): 时间彩虹配置

### 2. `prefs.js`
- 新增 Color Mode 下拉选择（4 种模式）
- 动态显示对应的配置面板：
  - Solid：原有 ColorButton + Alpha slider
  - Rainbow modes：Gtk.TextView（多行文本输入）+ 英文说明 + 错误提示
- 输入校验（实时）：
  - 至少 2 个色标
  - 有效的十六进制格式 `#RRGGBB`
  - 非最后一行必须包含大于 0 的数字参数
  - 比例模式：接受任意正数，自动归一化（无需校验和）
- 错误提示：红色 Gtk.Label 显示在文本框下方
- 重置按钮更新为同时重置新模式设置

### 3. `extension.js`
- `enable()`：读取新模式配置，解析 rainbow stops
- `_onCapturedEvent()`：
  - 时间模式：基于 `(Date.now() - trailStartTime) % period` 计算颜色，绑定到点位 `[x, y, timestamp, r, g, b]`
  - 其他模式：标准 `[x, y, timestamp]`
- `_onRepaint()`：
  - 定长/比例模式：预计算每个点位的颜色，按 segment 起止点取色
  - 时间模式：直接读取点位绑定的颜色 `[p[3], p[4], p[5]]`
  - Fast/Balance 模式：同样支持（按 split segment 起止点）
- 新增辅助方法：
  - `_parseRainbowConfig(text, mode)`：解析配置文本
  - `_getFixedLengthColor(dist)`：定长模式取色
  - `_getRatioColor(ratio)`：比例模式取色
  - `_getTimeColor(elapsed)`：时间模式取色（取模 + 区间混合）
  - `_lerpColor(c1, c2, t)`：RGB 线性插值
  - `_calculatePointColors(pts)`：预计算点位颜色（定长/比例）

---

## Default Configurations (English)

### Fixed-Length Rainbow
```
#FF0000 50
#00FF00 50
#0000FF
```

### Ratio Rainbow
```
#FF0000 1
#00FF00 1
#0000FF 1
```
> Treated as equal thirds after normalization (1/3, 1/3, 1/3).

### Time-Based Rainbow
```
#FF0000 500
#00FF00 500
#0000FF
```

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| 时间模式颜色绑定到点位 | 避免每帧重复计算；颜色在捕获时固定，绘制直接读取 |
| 时间模式基于绝对时间取模 | 实现持续流动的彩虹效果，颜色随时间循环变化 |
| 比例模式参数自动归一化 | 用户输入任意正数即可，内部自动计算比例，降低使用门槛 |
| 每种模式独立配置键 | 切换模式时保留各自配置，互不干扰 |
| Fast/Balance 同样支持彩虹 | 按 split segment 起止点着色，保持一致性 |
| 输入校验实时反馈 | 红色错误标签立即显示问题，无效配置不保存 |

---

## Implementation Order
1. Update gschema.xml
2. Update prefs.js
3. Update extension.js
4. Compile schema & test
5. Commit & push
