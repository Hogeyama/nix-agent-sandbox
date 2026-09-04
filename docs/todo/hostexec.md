nas hostexec pending が壊れています。src/lib/runtime_registry.ts:241-253 の掃除ループが ENOENT だけを握りつぶして EACCES を再送出するため、削除できない stale ディレクトリが1つあると listPending ごと落ちます。
