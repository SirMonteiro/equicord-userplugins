#!/usr/bin/env bash
set -euo pipefail

# Configuration
REPO_OWNER="SirMonteiro"
REPO_NAME="equicord-userplugins"
RELEASE_TAG="devbuild"

WORK_DIR="/tmp/equicord"
DIST_DIR="${WORK_DIR}/dist"
API_URL="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/${RELEASE_TAG}"
CLI_URL="https://github.com/Equicord/Equilotl/releases/latest/download/EquilotlCli-linux"

# 1. Verify required tools
for cmd in curl jq; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "[-] Error: Required command '$cmd' is not installed or not in PATH." >&2
        exit 1
    fi
done

# Check if EquilotlCli-linux or EquilotlCli exists locally/in PATH, else download it
INSTALLER_CMD=""
if command -v EquilotlCli-linux >/dev/null 2>&1; then
    INSTALLER_CMD="EquilotlCli-linux"
elif command -v EquilotlCli >/dev/null 2>&1; then
    INSTALLER_CMD="EquilotlCli"
elif command -v EquicordInstaller >/dev/null 2>&1; then
    INSTALLER_CMD="EquicordInstaller"
fi

# 2. Prepare directories
echo "[+] Preparing directory: ${DIST_DIR}"
rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}"

if [ -z "${INSTALLER_CMD}" ]; then
    echo "[+] Downloading EquilotlCli-linux..."
    curl -fsSL "${CLI_URL}" -o "${WORK_DIR}/EquilotlCli-linux"
    chmod +x "${WORK_DIR}/EquilotlCli-linux"
    INSTALLER_CMD="${WORK_DIR}/EquilotlCli-linux"
fi

# 3. Fetch asset download URLs from GitHub API
echo "[+] Fetching release asset list from ${REPO_OWNER}/${REPO_NAME} (${RELEASE_TAG})..."
RESPONSE=$(curl -fsSL -H "User-Agent: Equicord-Linux-Installer" "${API_URL}")

ASSET_COUNT=$(echo "${RESPONSE}" | jq '.assets | length')
if [ -z "${ASSET_COUNT}" ] || [ "${ASSET_COUNT}" -eq 0 ]; then
    echo "[-] Error: No assets found in the release." >&2
    exit 1
fi

echo "[+] Downloading ${ASSET_COUNT} files to ${DIST_DIR}..."

# 4. Download all assets directly into dist/ (skipping zip files)
INDEX=1
while IFS=$'\t' read -r name url; do
    if [[ "$name" == *.zip ]]; then
        continue
    fi
    printf "[%2d/%2d] Downloading %s\n" "$INDEX" "$ASSET_COUNT" "$name"
    curl -fsSL "$url" -o "${DIST_DIR}/${name}"
    INDEX=$((INDEX + 1))
done < <(echo "${RESPONSE}" | jq -r '.assets[] | [.name, .browser_download_url] | @tsv')

# 5. Run EquilotlCli pointing to the directory containing dist/
echo "[+] Injecting Equicord into Discord..."
export EQUICORD_USER_DATA_DIR="${WORK_DIR}"
export EQUICORD_DEV_INSTALL="1"

if ! "${INSTALLER_CMD}" -install; then
    echo "[-] Equicord installation failed." >&2
    exit 1
fi

# 6. Optional OpenAsar installation
echo "[+] Installing OpenAsar..."
"${INSTALLER_CMD}" -install-openasar || echo "[!] OpenAsar installation step skipped or failed."

# Clean up environment variables
unset EQUICORD_USER_DATA_DIR
unset EQUICORD_DEV_INSTALL

echo -e "\n[+] Equicord installation completed successfully. Restart Discord to apply changes."
