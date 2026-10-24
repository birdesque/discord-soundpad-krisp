# discord-soundpad-krisp

[![Build](https://github.com/birdesque/discord-soundpad-krisp/actions/workflows/build.yml/badge.svg)](https://github.com/birdesque/discord-soundpad-krisp/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/birdesque/discord-soundpad-krisp)](https://github.com/birdesque/discord-soundpad-krisp/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) · **Русский**

Небольшая утилита для Windows. Пока играет [Soundpad](https://www.leppsoft.com/soundpad/), она выключает шумодав Discord (Krisp), а потом включает его обратно.

## Проблема

Soundpad подмешивает звуки прямо в поток микрофона. Krisp считает музыку и звуковые эффекты шумом и вырезает их, поэтому собеседники слышат звуки приглушёнными или не слышат совсем. В Discord нет настройки или горячей клавиши, чтобы пропустить Soundpad мимо Krisp. Официальный RPC Discord управляет только «Стандартным» шумодавом, а Krisp ему недоступен.

## Что делает утилита

- Сама запускает Discord. Если он уже открыт, перезапускает его.
- Следит за Soundpad. Пока играет звук, шумодав выключен — Krisp или «Стандартный», какой у тебя стоит.
- Примерно через 400 мс после конца звука возвращает прежний режим.
- Если шумодав был выключен заранее, ничего не трогает.
- Работает без окна. Завершается, когда ты выходишь из Discord.

## Быстрый старт

1. Скачай `discord-soundpad-krisp.exe` из [последнего релиза](https://github.com/birdesque/discord-soundpad-krisp/releases/latest).
2. Положи его в любую папку и запусти. Discord откроется (или перезапустится) уже с утилитой.
3. Советую включить в Soundpad: **Файл → Настройки → Аудио → «Блокировать голос»**. Тогда, пока играет звук, микрофон молчит и собеседники слышат только звук. Заодно выключенный на это время Krisp ничего не портит.

Чтобы утилита запускалась вместе с Windows, отключи в Discord «Запускать Discord при включении компьютера». Потом положи ярлык на `discord-soundpad-krisp.exe` в автозагрузку (`Win+R` → `shell:startup`).

## Как это работает

```
Soundpad ──(named pipe: GetPlayStatus)──► SoundpadKrisp ──(DevTools pipe)──► Discord
```

- **Soundpad** опрашивается раз в 150 мс через его официальный [Remote Control](https://www.leppsoft.com/soundpad/rc) — именованный канал `\\.\pipe\sp_remote_control`.
- **Discord** запускается с ключом Chromium `--remote-debugging-pipe`. Канал DevTools — это пара наследуемых дескрипторов, которые есть только у SoundpadKrisp. Сетевой порт не открывается, и другие программы через этот канал подключиться не могут.
- Через этот канал утилита вызывает те же внутренние функции, что и переключатель шумодава в самом Discord: `setNoiseCancellation` (Krisp) и `setNoiseSuppression` («Стандартный»). Функции ищутся по названию действия `AUDIO_SET_NOISE_CANCELLATION`, а не по минифицированным номерам модулей, поэтому большинство обновлений Discord утилиту не ломают.
- Если Discord закрыли посреди звука, прежний режим сохраняется в `soundpad-krisp.state.json` и возвращается при следующем запуске.

Файлы Discord не изменяются.

## Ограничения

- **Discord живёт вместе с утилитой.** Chromium закрывается, когда рвётся канал DevTools. Если выйти из Discord, утилита завершится. Если завершить утилиту, закроется Discord.
- **К уже запущенному Discord подключиться нельзя.** Вместо этого утилита перезапускает его, и активный голосовой звонок оборвётся. Запускай утилиту до того, как зайдёшь в канал.
- **Обновления Discord.** Когда Discord ставит обновление и сам перезапускается, он запускается уже без утилиты. Просто запусти `discord-soundpad-krisp.exe` ещё раз.
- **Push-to-talk.** В этом режиме клавишу всё равно нужно держать, пока играет звук, иначе Discord ничего не передаёт. С активацией по голосу такой проблемы нет.
- **Только Windows.** И Soundpad, и раскладка папок Discord, на которую опирается утилита, есть только на Windows.

## Настройки

Необязательно. Создай `config.json` рядом с exe (образец — [`config.example.json`](config.example.json)):

| Ключ | По умолчанию | Что значит |
|---|---|---|
| `pollMs` | `150` | Как часто спрашивать Soundpad, играет ли он, в мс |
| `releaseDelayMs` | `400` | Сколько ждать после конца звука, прежде чем вернуть шумодав, в мс |

## Если что-то не так

Лог пишется в `soundpad-krisp.log` рядом с exe. Сообщения в нём на английском:

| Сообщение | Что значит |
|---|---|
| `Discord is still loading` | Обычное дело при запуске. Утилита сама попробует снова. |
| `Soundpad is not running, waiting…` | Soundpad не запущен. Запусти его, утилита подхватит сама. |
| `Noise suppression modules not found, Discord may have been updated` | Обновление Discord поменяло его внутренности. [Создай issue](https://github.com/birdesque/discord-soundpad-krisp/issues/new/choose). |
| `Discord not found in …` | Discord стоит не в стандартной папке пользователя (`%LOCALAPPDATA%\Discord`). |

Windows SmartScreen или антивирус могут ругаться на exe. Это `node.exe` со встроенным скриптом, и после встраивания исходная подпись Node становится недействительной. Каждый релиз собирает GitHub Actions из этого репозитория, а к релизу приложен файл `.sha256`, чтобы можно было проверить скачанный файл.

## Сборка из исходников

Нужны Windows и Node.js 22 или новее.

```bash
npm ci
npm run build
```

Exe появится в `dist/discord-soundpad-krisp.exe`. Сборщик упаковывает `src/soundpad-krisp.js` в [single executable application Node.js](https://nodejs.org/api/single-executable-applications.html) с помощью `postject` и переключает exe в оконный режим, чтобы не появлялась консоль.

Можно запустить и без сборки: `npm start`. Лог тогда идёт ещё и в консоль.

Релиз выпускается пушем тега `vX.Y.Z`. [Workflow](.github/workflows/build.yml) собирает exe и прикладывает его к релизу на GitHub.

## Отказ от ответственности

Это неофициальная утилита. Она не связана с Discord Inc. или Leppsoft (Soundpad) и не одобрена ими. Управление клиентом Discord через DevTools — это модификация клиента, и с точки зрения правил Discord это та же серая зона, что BetterDiscord и Vencord. Используй на свой риск.

## Лицензия

[MIT](LICENSE)
