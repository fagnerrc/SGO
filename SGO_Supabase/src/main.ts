import { startApp } from "./app";
import { initTimerDock } from "./views/timerDock";

const root = document.querySelector<HTMLDivElement>("#app")!;
startApp(root);

initTimerDock(document.querySelector<HTMLDivElement>("#timer-dock-mount")!);
