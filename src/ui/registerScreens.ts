import type { UiContext } from './context';
import type { Router } from './router';
import { cpuSetupScreen } from './screens/cpuSetup';
import { customizeScreen } from './screens/customize';
import { gateScreen } from './screens/gate';
import { howToScreen } from './screens/howTo';
import { mainMenuScreen } from './screens/mainMenu';
import { playScreen } from './screens/match';
import { registerOnlineScreens, type OnlineDeps } from './screens/online';
import { optionsScreen } from './screens/options';
import { pauseScreen } from './screens/pause';
import { resultsScreen } from './screens/results';
import { titleScreen } from './screens/title';
import { trainingScreen } from './screens/training';

/**
 * Registers every screen of spec §4.6 on `router`: gate, title, mainMenu, cpuSetup, customize,
 * options, howTo, the play screens 'match' and 'training', pause, results, and the online 'host'
 * and 'join' (which hand their matches over through `online`).
 */
export function registerScreens(router: Router, ctx: UiContext, online: OnlineDeps): void {
  router.register('gate', gateScreen(ctx));
  router.register('title', titleScreen(ctx));
  router.register('mainMenu', mainMenuScreen(ctx));
  router.register('cpuSetup', cpuSetupScreen(ctx));
  router.register('customize', customizeScreen(ctx));
  router.register('options', optionsScreen(ctx));
  router.register('howTo', howToScreen(ctx));
  router.register('match', playScreen(ctx, 'cpu'));
  router.register('training', trainingScreen(ctx));
  router.register('pause', pauseScreen(ctx));
  router.register('results', resultsScreen(ctx));
  registerOnlineScreens(router, online);
}
