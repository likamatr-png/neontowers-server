#!/usr/bin/env bash
# Установка сервера «Неоновые башни» на Ubuntu/Debian VPS.
# Запуск: sudo bash install-ubuntu.sh
set -e

if [ "$EUID" -ne 0 ]; then
  echo "Запусти с sudo: sudo bash install-ubuntu.sh"
  exit 1
fi

DEST=/opt/neon-towers
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Копирую файлы в $DEST"
mkdir -p "$DEST/db"
cp -r "$SCRIPT_DIR/mini-services" "$SCRIPT_DIR/src" "$DEST/"

if ! command -v bun >/dev/null 2>&1; then
  echo "==> Устанавливаю Bun..."
  curl -fsSL https://bun.sh/install | bash
fi
export BUN_INSTALL="${HOME}/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
BUN_PATH="$(command -v bun)"
echo "==> Bun найден: $BUN_PATH"

echo "==> Ставлю зависимости сервера..."
cd "$DEST/mini-services/game-server"
bun install --production

echo "==> Настраиваю автозапуск через systemd"
sed "s|{{BUN}}|$BUN_PATH|g" "$SCRIPT_DIR/neon-towers.service" > /etc/systemd/system/neon-towers.service
systemctl daemon-reload
systemctl enable --now neon-towers

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "active"; then
  echo "==> Открываю порт 3003 в файрволе ufw"
  ufw allow 3003/tcp
fi

IP=$(curl -s -m 5 ifconfig.me || true)
[ -z "$IP" ] && IP=$(hostname -I | awk '{print $1}')

sleep 2
if curl -s -m 3 "http://127.0.0.1:3003/socket.io/?EIO=4&transport=polling" | head -c 1 | grep -q '^0'; then
  echo ""
  echo "=============================================="
  echo " СЕРВЕР РАБОТАЕТ:  http://$IP:3003"
  echo ""
  echo " Впиши этот адрес в игре:"
  echo " Меню -> Адрес игрового сервера -> http://$IP:3003"
  echo " (все игроки вписывают один и тот же адрес)"
  echo ""
  echo " Проверка живости:  sudo systemctl status neon-towers"
  echo " Логи в реальном времени:  journalctl -u neon-towers -f"
  echo "=============================================="
else
  echo "Сервер не ответил — смотри логи:  journalctl -u neon-towers -f"
  exit 1
fi
