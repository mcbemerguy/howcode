run_with_project_node() {
  if [ -f .node-version ] && command -v fnm >/dev/null 2>&1; then
    fnm exec --using .node-version "$@"
    return
  fi

  if [ -f .node-version ] && command -v node >/dev/null 2>&1; then
    required_node_version="$(tr -d '[:space:]' < .node-version)"
    required_node_version="${required_node_version#v}"
    current_node_version="$(node -p "process.version.replace(/^v/, '')" 2>/dev/null || true)"
    if [ -n "$required_node_version" ] && [ -n "$current_node_version" ] && [ "$current_node_version" != "$required_node_version" ]; then
      echo "howcode: .node-version pins Node $required_node_version, but PATH resolves $(node -v) at $(command -v node)." >&2
      echo "howcode: run 'fnm install' / 'fnm use', or install fnm so hooks can select the pinned Node automatically." >&2
      exit 1
    fi
  fi

  "$@"
}
