# AI Plan Value

Simple page combining subscription subsidies ([Real API Pricing](https://github.com/Fei2411/real-api-pricing) / [Priors](https://mypriors.com/subsidies)) with [Artificial Analysis `#price-cost`](https://artificialanalysis.ai/models#price-cost) to rank real cost per task.

Auto-updates every 6 hours via GitHub Actions and deploys statically to GitHub Pages.

## Deploy to GitHub Pages (Auto-Updating)

1. Initialize git, create a GitHub repo, and push:

```bash
cd "/home/meow/Documents/Projects/ai value" && git init -b main && git add . && git commit -m "Initial commit: AI Plan Value" && gh repo create ai-plan-value --public --source=. --remote=origin --push
```

2. Enable GitHub Pages from GitHub Actions:

```bash
gh api --method POST "repos/$(gh api user -q .login)/ai-plan-value/pages" -f build_type=workflow
```

3. Trigger the first data refresh & deploy (after this it runs automatically every 6 hours and on every push to `main`):

```bash
gh workflow run deploy.yml --repo "$(gh api user -q .login)/ai-plan-value"
```

## Optional Local Preview

```bash
cd "/home/meow/Documents/Projects/ai value" && node server.mjs
```

Then open `http://127.0.0.1:3456`.
