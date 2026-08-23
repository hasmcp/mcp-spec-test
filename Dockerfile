# mcp-spec-test itself is plain Node, but the servers it is pointed at are not:
# in practice they are stdio processes written in Python, Node, Go, Rust or
# Ruby and launched the way their own README says (npx, uvx, go run, cargo
# run, bundle exec, ...). So the image carries a runtime and package manager
# for each of those, not just Node, or "-c" would only work for a fraction of
# real-world targets.
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    python3-pip \
    pipx \
    golang-go \
    ruby-full \
    build-essential \
    ca-certificates \
    git \
    curl \
  && rm -rf /var/lib/apt/lists/*

# uv/uvx is what most Python-based MCP servers document as their launch command.
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# Some MCP servers ship only as a cargo crate, run via `cargo run` or a
# published binary name.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /app

# Installed from the lockfile, same as CI, so the image gets the versions the
# suite was actually tested against rather than whatever npm resolves today.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bin ./bin
COPY lib ./lib
COPY spec ./spec
COPY README.md LICENSE ./

# tests/*.test.mjs are the conformance case files the CLI loads at runtime,
# not dev-only tests — only tests/unit/ is that. Mirrors package.json's
# "files" field ("tests/", "!tests/unit/") for what actually ships.
COPY tests ./tests
RUN rm -rf ./tests/unit

RUN npm link

ENTRYPOINT ["mcp-spec-test"]
CMD ["--help"]
