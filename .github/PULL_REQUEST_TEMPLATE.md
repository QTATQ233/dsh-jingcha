## 这个 PR 做了什么

<!-- 一两句话。如果是新判定规则，请写清判据与默认阈值。 -->

## 检查清单

- [ ] `node test/verify.mjs` 通过（当前 121 项）
- [ ] `node test/verify-client.mjs` 通过（当前 90 项）
- [ ] 若改了宿主接线，`node test/verify-cordis.mjs` 也通过（需要 DSH_CORDIS 环境变量）
- [ ] `node tools/prepare-publish.mjs` 末尾打印「隐私自检：通过」
- [ ] 新判定规则：已加进 README 的判定表，并在 cordis.patch.yml 里给出可调阈值
- [ ] 新设置项：宿主（WIDGET_DEFAULTS + sanitizeSettings）与挂件（DEFAULTS + sanitize）两端同步

## 三条铁律（见 CONTRIBUTING.md）

- [ ] **只观察不改写**：没有修改工具调用结果或取消语义；新代码路径包在 safe() 里
- [ ] **轮询不重建交互控件**：挂件 poll 里没有重建滑块 / 色板等交互元素
- [ ] **零依赖、默认 0 token**：没有引入第三方依赖；没有把 toolEnabled 默认改成 true

## 关联 issue

<!-- closes #123 -->
