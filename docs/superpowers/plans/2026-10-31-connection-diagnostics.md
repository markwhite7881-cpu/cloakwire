# Connection diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Проверять действительный доступ через выбранный профиль и безопасно показывать ошибки с привязкой к сессии.

**Architecture:** Новый diagnostics layer использует snapshot профиля и отдельные probes, оставляя ProcessManager и VpnService владельцами реального соединения. Состояние здоровья хранится отдельно от состояния процесса.

**Tech Stack:** Rust/Tauri 2, React 18/TypeScript, Kotlin/Android VpnService, существующие sing-box/libbox и Xray; Vitest, Cargo, JVM tests и отдельный OS/device test stand.

**Spec:** ../specs/2026-10-31-connection-reliability-and-ux-design.md

**Status:** Desktop active-session и Android selected-profile checkpoints реализованы; Android больше не отложен. Полная системная матрица, Android active-session health/recovery и завершение D2–D5 открыты. Отчёты: [desktop](../../testing/desktop-active-health-2026-10-31.md), [Android profile probe](../../testing/android-profile-probe-2026-10-31.md).

## Global Constraints

См. обязательные ограничения спецификации. Сохранять active_run_id/ready_check_epoch и PendingProfileStarts; stale results не меняют новый run. Probe не меняет TUN, proxy, routing, selection или сохранённый профиль. Использовать фактическое ядро профиля. Сохранять DNS/GeoIP/provider rules и текущую политику защиты при обрыве. Новые сообщения RU/EN/zh-CN; никакой телеметрии или секретов в отчётах. Не обновлять ядра и минимальные ОС. Системные тесты — только на выделенных устройствах.

## Review Focus

1. Stop/смена сервера во время probe/recovery: результат старой операции не меняет подключение (D1, D2, C1–C3).
2. Одинаковые имена и адреса, разные пользователи/подписки: нет случайного обновления соседней записи (B1, B2).
3. Активный TUN/другая физическая сеть: probe не закольцовывается и не даёт успех через чужой профиль (D2, D3).
4. Локальный bypass и provider/custom rules: интерфейс не обещает маршрутизацию, которой фактически нет (B3, C4).
5. Ошибка хранилища, migration/downgrade, погибшая Activity: данные и активная сессия восстанавливаются без ложного успеха (B1, B2, D3, B4, C3, C4).

## Проверки и окружение

- Быстрые frontend-проверки: npm test; npm run build.
- Rust unit на рабочей Windows: CLOAKWIRE_TEST_MANIFEST=1; cargo test --manifest-path src-tauri/Cargo.toml --lib -- --skip process:: --skip killswitch::. Перед этим проверить оставшиеся tests на системные изменения; новые такие тесты пометить ignored и запускать явно в VM.
- Полная cargo test --lib — на выделенном runner/VM. На macOS также выполнить native Cargo tests.
- Android: из src-tauri/gen/android выполнить .\gradlew.bat :app:testDebugUnitTest (Windows) / ./gradlew :app:testDebugUnitTest (macOS/Linux).
- Указать действительные JDK/SDK/NDK/Rust paths через release.local.psd1/environment. Не копировать ключи или локальный конфиг в Git.
- Каждый task: сначала тест с ожидаемым провалом, затем минимальная реализация, targeted checks и полный относящийся suite; git diff --check; отдельный коммит.

### D0. Baseline и воспроизводимый стенд до изменения поведения

**Files:** создать docs/testing/connection-baseline.md, scripts/test-connection-matrix.mjs, scripts/connection-matrix/fixtures.mjs, scripts/connection-matrix/report.mjs, scripts/connection-matrix/runner.mjs; изменить package.json только для test:connections; дополнить существующие tests рядом с config/ready.rs, commands.rs и process.rs при найденных пробелах.
**Interfaces:** CLI node scripts/test-connection-matrix.mjs --suite core --binaries <dir> --output <dir>; suite=core не меняет OS routes. JSON report включает commit/core hashes/case/platform/status и redacted error, без секретов. OS suite имеет отдельный явный --suite system, запрещён по умолчанию.

- [ ] Зафиксировать чистый HEAD, версии ядер, исходные результаты npm test/build и native suites; текущие провалы перечислить, не записывать как новые регрессии.
- [ ] Написать tests runner_limits_cleanup_and_redacts: timeout завершает только его process tree; секретный sentinel отсутствует в отчёте; обычный suite не вызывает TUN/proxy/firewall.
- [ ] Запустить node --test scripts/connection-matrix/*.test.mjs; увидеть ожидаемый провал, создать недостающие test files и реализовать helpers.
- [ ] Добавить синтетические сценарии: generated profile valid; malformed config; ready replacement invalid preserves live run; Stop invalidates late start; GeoIP rule_set UI fields absent; provider DNS preserved; process rules/final order.
- [ ] Для реального VLESS/Reality fixture генерировать временную пару ключей штатной командой ядра и отдельный TLS camouflage endpoint в изолированном стенде; в core suite допустим отдельно проверяемый VLESS loopback без Reality. Reality success/wrong-key должны стать обязательными системными release cases, а не public-server ping.
- [ ] Запустить baseline матрицу на 1.4.9; сохранить только redacted отчёт, без baseline reset при новых ошибках.
- [ ] Коммит test: establish connection regression baseline.

### D1. Контракты диагностики и владение операциями

**Files:** создать src/lib/connectionHealth.ts и .test.ts, src-tauri/src/diagnostics/{mod.rs,types.rs,coordinator.rs}; изменить src-tauri/src/lib.rs, src/lib/api.ts и при необходимости src/lib/types.ts. Android mirror DTO: ConnectionHealth.kt + JVM test.
**Interfaces:**
- ProfileRef = {kind:"manual",id:string} | {kind:"subscription",subscription_id:string,link_key:string} | {kind:"ready",subscription_id:string,child_key:string} | {kind:"auto",snapshot_id:string}.
- SessionIdentity = {profile_ref:ProfileRef, profile_revision:string, run_id:string|null, network_generation:string,effective_outbound_revision:string|null}. Wire IDs — строки, без потери u64 в JS.
- ConnectionHealth = SessionIdentity & {operation_id:string,scope:"selected_profile"|"active_session",stage:HealthStage,outcome:HealthOutcome,issue:HealthIssue|null,checked_at:string|null,latency_ms:number|null}.
- Native ProbeTarget = Manual{id,outbound,settings} | Subscription{reference,settings} | Ready{reference,routing}; revision вычисляет/проверяет native, UI не считается источником истины для backend subscriptions.
- start_profile_probe(target:ProbeTarget) -> operation_id; cancel_profile_probe(operation_id) -> (); get_connection_health() -> snapshot. Событие connection_health содержит только DTO.
- applyHealthEvent(current, event, expected:SessionIdentity): ConnectionHealth принимает событие только для актуальной identity.

- [x] Tests reject_stale_run_revision_and_network; stop_invalidates_probe; identical_request_coalesces; two_requested_profiles_do_not_cross; snapshot_survives_ui_resubscribe. Assert старое событие не заменяет здоровый новый run.
- [x] Запустить npm test -- src/lib/connectionHealth.test.ts и cargo test --manifest-path src-tauri/Cargo.toml diagnostics::; убедиться в ожидаемом провале.
- [x] Реализовать отдельный coordinator с одной активной probe, отменой, deadline 12s и cleanup budget 2s; не удерживать semaphore основного lifecycle во время сетевого ожидания.
- [x] Добавить контрактные JSON fixtures без секретов и проверить одинаковую сериализацию Rust/TS/Kotlin; issues/actions только enum.
- [x] Запустить targeted checks и npm test/build; коммит feat: add session-owned connection health contracts.

### D2. Реальные desktop probes

Checkpoint 2026-10-31: private process/config owner, cancellation/deadline cleanup, authenticated socket readiness, bounded collision retry, fixed HTTPS client and read-only physical discovery implemented. Independent review fixed five isolation/ownership issues. Production Xray probes unavailable because the bundled core ignores binding errors; test-only loopback runs do not bypass this production gate. Active-session attribution and full OS isolation remain open.

**Files:** создать src-tauri/src/diagnostics/{desktop.rs,probe_config.rs,network.rs,targets.rs}; изменить engine/singbox.rs, engine/xray.rs, subscriptions/mod.rs, config/ready.rs и xray/mod.rs; tests в новых модулях и scripts/connection-matrix.
**Interfaces:** prepare_probe(target, resolved_snapshot, physical_network) -> ProbeConfigLease; DesktopProbe::run(request, cancellation) -> ConnectionHealth; ProbeConfigLease владеет temp directory, log sinks и созданными process handles.
**Decision:** использовать существующие serializers. Копию provider-конфига преобразовать минимально: private loopback inbound, путь проверки к доказанному proxy target, сохранённые detour/DNS dependencies; если целевой outbound неоднозначен — unsupported_probe.

- [ ] Tests profile_a_test_cannot_succeed_through_active_b; ready_detour_dns_dependencies_survive; probe_never_writes_system_proxy; missing_interface_unavailable; selector_pinned_for_probe_without_persisting; reserved_port_collision_retries_bounded; child_removed_on_cancel_and_timeout.
- [ ] На synthetic core fixture проверить FAIL для несуществующего target/probe implementation, затем реализовать startup readiness по socket, а не fixed sleep.
- [ ] Реализовать network binding для актуального физического интерфейса Windows/macOS. Прямой тест не наследует HTTP_PROXY/system proxy; traffic к server IP не захватывается активным TUN.
- [x] Реализовать HTTPS targets/expected status/response bound по спецификации; в live adapter не принимать 3xx за успех и не отключать сертификаты.
- [ ] Добавить ActiveSessionProbe::run(identity, cancellation), который обращается к текущему процессу через controller/private authenticated inbound. В runtime-копии private inbound/rule match исключительно свой tag, проходят preflight и не меняют обычные rules. Tests temporary_core_success_does_not_mark_active_healthy; auto_member_changed_invalidates_result; active_probe_only_matches_private_inbound.
- [ ] Протестировать DNS и ошибку Reality отдельно от доступности test-site; unsupported provider shape не проходит зелёным.
- [ ] Проверить sing-box и Xray с VPN off/on в выделенной Windows VM и macOS; основная сессия, selected outbound и OS routes до/после идентичны.
- [ ] Native suites + core matrix; коммит feat: add isolated desktop profile probes.

### D3. Android probes с сохранением активного VPN

Checkpoint 2026-10-31: продуктовая проверка выбранного профиля, private :profile_diagnostics service, trusted preparation, UI и invalidation реализованы. Итоговый APK: 4 сочетания active/probe ядер × 12 PASS; manual/UI 2 × 13 PASS; DNS edit 4 PASS и Wi-Fi invalidation PASS. JVM63, frontend168, safe diagnostics54 PASS. [Подробный отчёт и сохранённые ограничения](../../testing/android-profile-probe-2026-10-31.md). Общие пункты D3 не закрываются частичной матрицей: active-session checks, older Android/lockdown, Hysteria2/TUIC и все lifecycle-сценарии ещё не завершены.

**Files:** изменить LatencyTester.kt, SingBoxEngine.kt, VpnPlugin.kt, AndroidManifest.xml в src-tauri/gen/android/app/src/main; создать vpn/{ConnectionProbeService.kt,ProbePlatform.kt,ProbeCoordinator.kt,ProbeConfig.kt,OwnedCoreProcess.kt}; tests в соответствующих src/test и src/androidTest; src/lib/vpn.ts.
**Interfaces:** plugin:vpn|probe(target) -> operation_id; plugin:vpn|cancelProbe(operation_id); health event/snapshot совпадают с D1. Rust готовит secret-bearing config внутри существующего trusted path; IPC service не exported.
**Dependency:** D1, probe configuration contract D2; B1 нужен только для UI wiring manual identity.

- [ ] Написать/получить FAIL для session_cleanup_preserves_probe_process, probe_cleanup_preserves_session, stale_restart_thread_cannot_start_new_session. В XrayEngine.kt/CloakwireVpnService.kt заменить cleanup по имени/pkill на OwnedCoreProcess lease и generation check. Orphan cleanup проверяет UID/config-token/process start time; не убивать PID после его переиспользования.
- [ ] Первый тест-эксперимент: два libbox владельца в разных Android processes с разными base/working/temp/command socket paths; active TUN session survives probe start/stop. ProbePlatform.openTun должен всегда отвергать запрос.
- [ ] До продуктового wiring подтвердить на реальном AAR: concurrent service lifetime, physical DNS/TCP/UDP binding, binder cancellation, независимость command client и логов. При несовместимости остановить этот task и пересмотреть adapter; не имитировать успех тестом Xray.
- [ ] JVM tests limits_and_cleanup, cancelled_operation_cannot_emit, redaction; device tests active_vpn_unchanged, app_excluded_still_tests_through_profile, network_lost_invalidates_probe, activity_recreation_reads_snapshot.
- [ ] Реализовать отдельный :diagnostics service, cancellation при binder death/Stop, уникальные config files, readiness вместо 1200ms. Xray сохранить совместимость существующей latency button.
- [ ] Проверить sing-box-specific Hysteria2/TUIC профили собственным ядром на стенде; Xray ready config отдельно. always-on/lockdown restriction отдаёт unavailable, не successful direct fallback.
- [ ] JVM suite, Android assembleDebug, device matrix; коммит feat: add isolated Android connection checks.

#### Контрольная точка D3: процессная изоляция

- [x] Удалить глобальную очистку Xray по имени; ввести owned process/config и проверяемые orphan leases.
- [x] Защитить отложенный restart и его callbacks поколением сессии, проверить повторное использование PID и разделение владельцев.
- [x] На реальном Android AAR проверить два libbox-процесса, отдельный command channel/пути, запрет TUN, DNS/TCP/UDP через физическую Network.
- [x] Проверить отмену, гибель Binder-клиента, аварию diagnostics и сохранение HTTPS-трафика другого UID.
- [ ] Завершить production adapter и оставшуюся D3-матрицу (lockdown, смена сети, старшие/младшие ОС, profile ownership, Stop, Hysteria2/TUIC).

Дополнение 2026-10-31: исправлены platform DNS экспериментального probe и потеря Reality fingerprint в Android Xray mapper. На окончательной сборке оба рабочих ядра прошли libbox isolation 13/13 и temporary Xray lifetime 8/8; маршрутизация 8/8. Эта матрица закрывает контрольную точку на подключённом Android 16, но не общие пункты D3.

Экспериментальная служба находится только в debug. [Отчёт и ограничения](../../testing/android-isolation-2026-10-31.md). Общие пункты D3 выше не отмечаются целиком выполненными, пока объединённые зависимости не закрыты.

### D4. Безопасная классификация ошибок работающей сессии

**Files:** создать src-tauri/src/diagnostics/issues.rs, src/lib/connectionIssues.ts и .test.ts, Kotlin vpn/ConnectionIssues.kt и test; изменить process.rs logging hook, SingBoxEngine.kt log hook, XrayEngine.kt stderr hook, VpnEvents.kt, src/lib/profileCheck.ts.
**Interfaces:** classify_runtime_issue(engine, redacted_signal, owner) -> Option<RuntimeIssue>; RuntimeIssue={code,severity,run_id,profile_ref,count,actions}; severity=notice|connection. Raw strings не пересылаются новым API.
- [ ] Tests reality_message_does_not_claim_wrong_uuid; destination_timeout_not_global_disconnect; unknown_message_omits_secret_sentinel; old_run_cannot_emit; repeats_coalesce; healthy_new_run_clears_old_issue.
- [ ] Проверить FAIL, реализовать allowlisted categories/actions на основе core versions фактической сборки.
- [ ] Подтверждение session-level failure: процесс умер либо health check и runtime evidence указывают на одну ошибку; единичный destination error остаётся notice.
- [ ] Сохранить все существующие preflight error codes и cancellation semantics.
- [ ] Rust/JVM/frontend suites и redaction sentinel checks; коммит feat: classify runtime connection failures safely.

### D5. Интеграция probes с текущим запуском

**Files:** изменить commands.rs, process.rs, CloakwireVpnService.kt, VpnPlugin.kt, VpnEvents.kt; добавить tests в managed_launch/preflight/diagnostics modules.
**Interfaces:** после принятого start публикуется active SessionIdentity; один post-start probe использует принятый snapshot. Старые StatusReport/VpnStatus поля сохраняются; новые identity/health поля additive.
**Dependencies:** D1–D4; B1 для стабильной manual identity.
- [ ] Tests subscription_reorder_invalidates_health_but_keeps_positional_selection; auto_member_change_resets_effective_health; bad_ready_candidate_preserves_active_identity_health; post_start_failure_does_not_stop_engine; stop_during_probe_no_late_reconnect; selection_does_not_relabel_active_run; auto_selection_health_not_attributed_to_manual_candidate.
- [ ] Сначала FAIL, затем подключить события существующих владельцев lifecycle. Preflight по-прежнему предшествует остановке рабочего соединения.
- [ ] Никакой сети в критической секции start/stop. Новый probe не откладывает пользовательское Stop.
- [ ] Полные safe native/frontend suites; dedicated lifecycle matrix; коммит feat: report health for accepted VPN sessions.

## Выход из части A

Готовы native probes, typed state/issues и поколение активной сессии. UI из части B использует эти данные. Автовосстановление ещё выключено. Пользовательские сети/серверы для CI не используются.
