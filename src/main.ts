import "./style.css";
import { Game } from "./game/game";

const canvas = document.querySelector<HTMLCanvasElement>("#game-canvas");
const app = document.querySelector<HTMLElement>("#app");

if (!canvas || !app) {
  throw new Error("页面结构缺失");
}

app.innerHTML = `
  <div class="boot-screen" id="boot-screen">
    <div class="boot-mark">
      <span>KR</span>
      <strong>跑跑卡丁车</strong>
    </div>
    <div class="boot-bar"><i></i></div>
  </div>
  <div id="menu-root"></div>
  <div id="game-ui"></div>
`;

const menuRoot = document.querySelector<HTMLElement>("#menu-root");
const gameUiRoot = document.querySelector<HTMLElement>("#game-ui");

if (!menuRoot || !gameUiRoot) {
  throw new Error("页面结构缺失");
}

const game = new Game(canvas, menuRoot, gameUiRoot);
game
  .init()
  .then(() => {
    document.querySelector("#boot-screen")?.remove();
  })
  .catch((error: unknown) => {
    const boot = document.querySelector<HTMLElement>("#boot-screen");
    if (boot) {
      boot.innerHTML = `
        <div class="boot-mark"><span>!</span><strong>页面加载失败</strong></div>
        <p class="boot-error">${error instanceof Error ? error.message : "未知错误"}</p>
        <button type="button" class="primary-button" onclick="location.reload()">重试</button>
      `;
    }
  });
