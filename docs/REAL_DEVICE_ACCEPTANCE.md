# HTTPS 与 Android 真机验收

本清单只能在候选提交已经部署到同域 HTTPS 环境后执行。不得把 mock、桌面浏览器响应式模式或静态代码检查记为 PASS。

## 记录但不泄密

- 候选 Git SHA、部署 URL、测试日期；
- Android 设备型号、系统版本、Chrome 版本；
- 测试账号使用不可逆标签，不记录用户名、手机号、Cookie 或二维码；
- 网络环境与地区；
- 失败项的页面截图和已脱敏网络日志。

## 必须逐项通过

1. Chrome 打开 HTTPS 深链，无崩溃、白屏或严重控制台错误。
2. 安装到主屏幕，standalone 启动，图标与主题色正确。
3. 同一部手机保存二维码，并由网易云官方客户端从相册识别完成登录。
4. 刷新与进程回收后会话恢复；登出后刷新仍为未登录。
5. 本人歌单、收藏和推荐至少各抽查一个；一个真实歌单可加入队列。
6. 播放、暂停、进度、上一首、下一首与歌词可用。
7. 锁屏和切后台连续播放 30 分钟；系统媒体控件正确。
8. 访问过的业务深链在断网后仍打开应用壳；恢复网络后可继续操作。
9. 播放中收到 Service Worker 更新时不自动中断；暂停后由用户确认更新。
10. 登出后检查 Local Storage、IndexedDB、Cache Storage、请求/响应和日志，无网易凭证 canary。
11. 抓包确认没有广告、推广、统计或行为分析请求。

## 100 首冻结样本

复制 `verification/playback-sample.template.json`，填入至少 100 首当前账号合法可访问的样本并冻结文件；复制结果模板逐首记录。完成后运行：

```sh
node scripts/verify-playback-sample.mjs verification/playback-sample.json verification/playback-result.json
```

只有可播放率至少 99%、所有可播放结果身份匹配且错配为 0，脚本才会返回成功。不可播放与版权限制必须如实记录，不能用错误歌曲替代。

每次尝试都要记录 `source`、`outcome` 和 UTC `observedAt`；可播放结果还要记录实际标题、歌手、专辑、时长、最终音源以及至少 15 秒（短曲按验证器下限）的实际播放观察。不可播放结果不得填写 `resolvedSource` 或伪造“实际曲目”元数据，`observedPlaybackSeconds` 必须为 0。

结果中的环境字段必须使用真实 HTTPS 地址、`Chrome/x.x.x.x; Android N; 设备型号` 格式和不可逆账号哈希。验证器只证明文件结构、集合、身份比较和阈值自洽，不能证明人工确实执行过播放；最终验收还必须保留独立评估员可核验的真机记录、脱敏网络证据或视频。
