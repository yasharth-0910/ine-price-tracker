// Chromium launch tuning for the Render 512MB free instance. Referenced by the
// BrowserFetcher (built in a later phase); kept here so the memory-fit knobs live in one place.
// ponytail: fixed args for the 512MB tier — revisit if we ever move off free Render.
export const BROWSER_LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

export const browserLaunchOptions = {
  headless: true,
  args: BROWSER_LAUNCH_ARGS,
};
