test "dirname: basic path" {
  inspect(dirname("/home/user/project"), content=(
    #|/home/user
  ))
}

test "dirname: root child" {
  inspect(dirname("/home"), content=(
    #|/
  ))
}

test "dirname: root" {
  inspect(dirname("/"), content=(
    #|/
  ))
}

test "dirname: nested" {
  inspect(dirname("/a/b/c/d"), content=(
    #|/a/b/c
  ))
}

test "parse_config_json: minimal config" {
  let json =
    #|{"default":"test","profiles":{"test":{"agent":"claude"}}}
  let config = parse_config_json(json)
  inspect(config.default_, content=(
    #|Some("test")
  ))
  inspect(config.profiles.length(), content=(
    #|1
  ))
  inspect(config.profiles.get("test").unwrap().agent, content=(
    #|Claude
  ))
}

test "parse_config_json: copilot agent" {
  let json =
    #|{"profiles":{"p1":{"agent":"copilot","agent-args":["--allow-all"]}}}
  let config = parse_config_json(json)
  let p = config.profiles.get("p1").unwrap()
  inspect(p.agent, content=(
    #|Copilot
  ))
  inspect(p.agent_args, content=(
    #|["--allow-all"]
  ))
}

test "parse_config_json: docker and nix config" {
  let json =
    #|{"profiles":{"dev":{"agent":"claude","docker":{"enable":true},"nix":{"enable":true,"mount-socket":true}}}}
  let config = parse_config_json(json)
  let p = config.profiles.get("dev").unwrap()
  inspect(p.docker.enable, content=(
    #|true
  ))
  inspect(p.nix.enable, content=(
    #|true
  ))
  inspect(p.nix.mount_socket, content=(
    #|true
  ))
}

test "parse_config_json: env entries" {
  let json =
    #|{"profiles":{"dev":{"agent":"claude","env":[{"key":"TZ","val":"Asia/Tokyo"},{"key":"LANG","val":"en_US.UTF-8"}]}}}
  let config = parse_config_json(json)
  let p = config.profiles.get("dev").unwrap()
  inspect(p.env.length(), content=(
    #|2
  ))
  inspect(p.env[0].key, content=(
    #|TZ
  ))
  inspect(p.env[0].val, content=(
    #|Asia/Tokyo
  ))
  inspect(p.env[1].key, content=(
    #|LANG
  ))
}

test "parse_config_json: network allowlist" {
  let json =
    #|{"profiles":{"dev":{"agent":"claude","network":{"allowlist":["api.example.com","cdn.example.com"]}}}}
  let config = parse_config_json(json)
  let p = config.profiles.get("dev").unwrap()
  inspect(p.network.allowlist, content=(
    #|["api.example.com", "cdn.example.com"]
  ))
}

test "parse_config_json: empty profiles" {
  let json =
    #|{"default":"x","profiles":{}}
  let config = parse_config_json(json)
  inspect(config.default_, content=(
    #|Some("x")
  ))
  inspect(config.profiles.length(), content=(
    #|0
  ))
}

test "parse_config_json: defaults for missing fields" {
  let json =
    #|{"profiles":{"bare":{"agent":"codex"}}}
  let config = parse_config_json(json)
  let p = config.profiles.get("bare").unwrap()
  inspect(p.agent, content=(
    #|Codex
  ))
  inspect(p.docker.enable, content=(
    #|false
  ))
  inspect(p.nix.enable, content=(
    #|false
  ))
  inspect(p.network.allowlist, content=(
    #|[]
  ))
  inspect(p.env, content=(
    #|[]
  ))
  inspect(p.extra_mounts, content=(
    #|[]
  ))
}
