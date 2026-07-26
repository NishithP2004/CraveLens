export const historyThemeCss = `
  :host .panel,
  :host .reveal {
    background: linear-gradient(155deg, #171713d9, #0d0d0bbc);
    border-color: #ffffff2e;
    background-clip: padding-box;
    box-shadow: 0 18px 60px #0009, inset 0 1px 0 #ffffff12;
    -webkit-backdrop-filter: blur(16px) saturate(125%);
    backdrop-filter: blur(16px) saturate(125%);
  }
  :host .head {
    background: #191915d9;
    -webkit-backdrop-filter: blur(12px) saturate(120%);
    backdrop-filter: blur(12px) saturate(120%);
  }
  :host([data-theme="light"]) .panel,
  :host([data-theme="light"]) .reveal {
    background: linear-gradient(155deg, #ffffffdc, #f8f8f4b3);
    color: #181814;
    border-color: #8f887b8f;
    box-shadow: 0 18px 60px #1b1b1838, inset 0 1px 0 #ffffffed;
    -webkit-backdrop-filter: blur(22px) saturate(135%);
    backdrop-filter: blur(22px) saturate(135%);
  }
  :host([data-theme="light"]) .head { background: #ffffffb8; }
  :host([data-theme="light"]) .head b,
  :host([data-theme="light"]) .cart > b { color: #181814; }
  :host([data-theme="light"]) .head button {
    background: #1818140c;
    color: #716f65;
  }
  :host([data-theme="light"]) details { border-color: #18181412; }
  :host([data-theme="light"]) summary small,
  :host([data-theme="light"]) .cart { color: #716f65; }
  :host([data-theme="light"]) .cart .history-delete {
    border-color: #18181414;
    background: #18181408;
    color: #716f65;
  }
`;

export const interfaceThemeCss = `
  aside {
    background: linear-gradient(160deg, #181814dc, #0d0d0bc4);
    border-color: #ffffff2e;
    background-clip: padding-box;
    box-shadow: 0 28px 90px #000a, inset 0 1px 0 #ffffff13;
    -webkit-backdrop-filter: blur(18px) saturate(125%);
    backdrop-filter: blur(18px) saturate(125%);
  }
  .restaurant-head {
    display: grid;
    grid-template-columns: 62px minmax(0, 1fr) auto;
    align-items: center;
    gap: 13px;
  }
  .restaurant-logo {
    display: grid;
    place-items: center;
    width: 62px;
    height: 62px;
    box-sizing: border-box;
    object-fit: cover;
    border: 1px solid #ffffff15;
    border-radius: 16px;
    background: #28241e;
    color: #ff8c69;
    font: 700 24px/1 Georgia, serif;
  }
  .restaurant-copy { min-width: 0; }
  .restaurant-copy h3 {
    margin: 0 0 5px;
    overflow-wrap: anywhere;
  }
  .restaurant-copy p {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 4px 0 0;
    color: #aaa69d;
    font-size: 11px;
    font-weight: 650;
  }
  .restaurant-copy p i { color: #5f5c55; font-style: normal; }
  .restaurant-rating {
    display: grid;
    align-self: center;
    justify-items: center;
    gap: 3px;
  }
  .restaurant-rating b {
    padding: 5px 8px;
    border-radius: 9px;
    background: #167553;
    color: #fff;
    font-size: 11px;
    white-space: nowrap;
  }
  .restaurant-rating small {
    color: #8f8d85;
    font-size: 8.5px;
    white-space: nowrap;
  }
  .section-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .section-title-row .section-title { margin-bottom: 0; }
  .receipt-heading-actions { display: flex; align-items: center; gap: 6px; }
  .open-menu {
    padding: 5px 7px;
    border: 1px solid #ff704340;
    border-radius: 8px;
    background: #ff704312;
    color: #ff9b7d;
    font-size: 8.5px;
  }
  .receipt-row.item { align-items: flex-start; }
  .receipt-row.item > span { flex: none; }
  .receipt-item {
    display: flex;
    flex: 1;
    min-width: 0;
    gap: 9px;
  }
  .expand-item-image {
    display: block;
    flex: none;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 15px;
    background: transparent;
    line-height: 0;
    cursor: zoom-in;
  }
  .receipt-item .expand-item-image { border-radius: 10px; }
  .receipt-item-image {
    display: block;
    width: 46px;
    height: 46px;
    object-fit: cover;
    border: 1px solid #ffffff12;
    border-radius: 10px;
    background: #272722;
  }
  .receipt-item-copy { min-width: 0; overflow-wrap: anywhere; }
  .receipt-item-name { display: flex; align-items: flex-start; gap: 6px; }
  .product-rating {
    display: inline-flex;
    align-items: center;
    margin-top: 4px;
    padding: 2px 5px;
    border-radius: 6px;
    background: #143c32;
    color: #66d5b3;
    font-size: 9px;
    font-weight: 800;
  }
  .product-rating small {
    display: inline !important;
    margin: 0 !important;
    color: inherit !important;
    font-size: 8px !important;
  }
  .dietary-icon {
    display: grid;
    place-items: center;
    width: 12px;
    height: 12px;
    flex: none;
    margin-top: 2px;
    border: 1.5px solid currentColor;
  }
  .dietary-icon i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  .dietary-icon.veg { color: #4caf50; }
  .dietary-icon.non_veg { color: #d9534f; }
  .item-description {
    margin: 4px 0 0;
    padding: 0;
    border: 0;
  }
  .item-description summary {
    color: #aaa69c;
    font-size: 9.5px;
    font-weight: 700;
  }
  .item-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }
  .quantity-control {
    display: flex;
    align-items: center;
    overflow: hidden;
    border: 1px solid #ffffff18;
    border-radius: 8px;
  }
  .quantity-control button {
    width: 25px;
    height: 24px;
    padding: 0;
    border-radius: 0;
    background: #ffffff08;
    color: #f1ede3;
  }
  .quantity-control button:disabled { opacity: .35; }
  .quantity-control span {
    min-width: 24px;
    text-align: center;
    font-size: 9px;
    font-weight: 800;
  }
  .item-remove {
    padding: 4px 6px;
    background: transparent;
    color: #d87969;
    font-size: 8.5px;
  }
  .agent-composer {
    margin: 14px -8px -8px;
    padding: 15px;
    border: 1px solid #ff704326;
    border-radius: 18px;
    background: #211711;
  }
  .customize-form { margin: 0; }
  .customize-form > label {
    display: block;
    margin-bottom: 7px;
    color: #e0dbd0;
    font-size: 11px;
    font-weight: 750;
  }
  .customize-form > div {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 42px;
    align-items: stretch;
    gap: 7px;
  }
  .customize-form textarea {
    box-sizing: border-box;
    width: 100%;
    min-height: 52px;
    padding: 10px 11px;
    resize: vertical;
    border: 1px solid #ffffff18;
    border-radius: 13px;
    outline: none;
    background: #0f0f0d99;
    color: #f8f5ea;
    font: 11px/1.4 Inter, Arial, sans-serif;
  }
  .customize-form textarea::placeholder { color: #77746c; }
  .customize-form textarea:focus {
    border-color: #ff7043;
    box-shadow: 0 0 0 2px #ff70431c;
  }
  .customize-form button {
    display: grid;
    place-items: center;
    padding: 0;
    border: 1px solid #ff704348;
    background: #3b2119;
    color: #ff9a7c;
  }
  .customize-form svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .customize-form small {
    display: block;
    margin-top: 6px;
    color: #8f897f;
    font-size: 9.5px;
  }
  .delivery {
    border: 1px solid #ffffff30;
    background: linear-gradient(145deg, #2b231bc9, #17130fbd);
    background-clip: padding-box;
    box-shadow:
      inset 0 1px 0 #ffffff14,
      inset 0 -1px 0 #00000040,
      0 10px 26px #00000038;
    -webkit-backdrop-filter: blur(12px) saturate(125%);
    backdrop-filter: blur(12px) saturate(125%);
  }
  .delivery > span {
    text-shadow: 0 0 12px #ff704366;
  }
  .cart-editor-dialog,
  .item-image-lightbox {
    background: #151512d5;
    background-clip: padding-box;
    box-shadow: 0 30px 100px #000c, inset 0 1px 0 #ffffff12;
    -webkit-backdrop-filter: blur(18px) saturate(120%);
    backdrop-filter: blur(18px) saturate(120%);
  }
  .cart-editor-dialog {
    width: min(390px, calc(100vw - 28px));
    max-width: none;
    max-height: min(76vh, 680px);
    margin: auto;
    padding: 0;
    overflow: hidden;
    border: 1px solid #ffffff1c;
    border-radius: 20px;
    color: #f4f0e6;
    font: 11px/1.45 Inter, Arial, sans-serif;
  }
  .cart-editor-dialog::backdrop,
  .item-image-lightbox::backdrop {
    background: #000b;
    -webkit-backdrop-filter: blur(5px);
    backdrop-filter: blur(5px);
  }
  .cart-editor-dialog > div {
    position: relative;
    padding: 18px;
  }
  .dialog-close {
    position: absolute;
    top: 12px;
    right: 12px;
    display: grid;
    place-items: center;
    width: 29px;
    height: 29px;
    padding: 0;
    border-radius: 9px;
    background: #ffffff0c;
    color: #b9b4a9;
  }
  .dialog-icon {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    margin-bottom: 12px;
    border-radius: 12px;
    background: #ff704319;
    color: #ff8d6a;
    font-size: 20px;
  }
  .cart-editor-dialog h3 {
    margin: 0;
    padding-right: 32px;
    font-size: 20px;
  }
  .cart-editor-dialog p { color: #99958b; }
  .dialog-actions { display: flex; gap: 8px; margin-top: 16px; }
  .dialog-actions button { flex: 1; }
  .dialog-cancel { background: #ffffff0c; color: #d2cdc2; }
  .dialog-cancel:hover { background: #ffffff16; }
  .dialog-confirm { background: #ff6440; color: #fff; }
  .item-image-lightbox {
    width: min(620px, calc(100vw - 32px));
    max-width: none;
    margin: auto;
    padding: 0;
    border: 0;
    border-radius: 22px;
    color: #f8f5ea;
  }
  .item-image-lightbox > div {
    position: relative;
    padding: 14px;
  }
  .item-image-lightbox img {
    display: block;
    width: 100%;
    max-height: min(72vh, 680px);
    object-fit: contain;
    border-radius: 14px;
    background: #0a0a09;
  }
  .image-lightbox-copy { padding: 11px 4px 3px; }
  .item-image-lightbox .image-lightbox-name {
    margin: 0;
    font: 700 13px/1.4 Inter, Arial, sans-serif;
  }
  .item-image-lightbox .image-lightbox-description {
    margin: 5px 0 0;
    color: #aaa69d;
    font: 400 11px/1.5 Inter, Arial, sans-serif;
    white-space: pre-wrap;
  }
  .item-image-lightbox .image-lightbox-description.muted {
    color: #77746c;
    font-style: italic;
  }
  .item-image-lightbox .image-lightbox-close {
    position: absolute;
    top: 22px;
    right: 22px;
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    padding: 0;
    border: 1px solid #ffffff24;
    border-radius: 11px;
    background: #111d;
    color: #fff;
    box-shadow: 0 5px 18px #0008;
  }
  .image-lightbox-close svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }
  .menu-picker > div {
    box-sizing: border-box;
    max-height: min(76vh, 680px);
    overflow-y: auto;
    padding-bottom: 34px;
    scroll-padding-bottom: 34px;
  }
  .menu-list {
    display: grid;
    gap: 7px;
    margin-top: 13px;
    padding-bottom: 18px;
  }
  .menu-list article {
    display: grid;
    grid-template-columns: 42px minmax(0, 1fr) auto;
    align-items: center;
    gap: 9px;
    padding: 8px;
    border: 1px solid #ffffff0d;
    border-radius: 12px;
    background: #ffffff05;
  }
  .menu-list .expand-item-image,
  .menu-item-image,
  .menu-image-fallback {
    width: 42px;
    height: 42px;
    border-radius: 9px;
  }
  .menu-item-image {
    display: block;
    object-fit: cover;
    background: #292820;
  }
  .menu-image-fallback {
    display: grid;
    place-items: center;
    background: #292820;
    color: #c99469;
  }
  .menu-image-fallback svg {
    width: 27px;
    height: 27px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .menu-list article > div { min-width: 0; }
  .menu-item-name { display: flex; align-items: flex-start; gap: 5px; }
  .menu-list b,
  .menu-list small,
  .menu-list strong { display: block; }
  .menu-list b { font-size: 10px; }
  .menu-list small {
    max-height: 44px;
    margin-top: 3px;
    padding-right: 3px;
    overflow-y: auto;
    color: #89857c;
    font-size: 8px;
    line-height: 1.4;
    white-space: normal;
    overflow-wrap: anywhere;
    scrollbar-width: thin;
  }
  .menu-list strong {
    margin-top: 4px;
    color: #e4ded2;
    font-size: 9px;
  }
  .menu-add {
    padding: 7px 9px;
    border: 1px solid #ff704344;
    background: #342018;
    color: #ff9677;
    font-size: 8px;
  }
  .menu-add:disabled {
    border-color: #ffffff10;
    background: #ffffff08;
    color: #77736b;
    cursor: not-allowed;
  }
  .receipt {
    overflow: hidden;
    padding: 0;
    border-color: #ffffff32;
    background: #ffffff08;
    box-shadow: inset 0 1px 0 #ffffff16, 0 12px 32px #00000026;
  }
  .receipt .section-title-row {
    min-height: 34px;
    padding: 13px 14px 11px;
    border-bottom: 1px solid #ffffff0d;
  }
  .receipt .cart-edit-status { margin: 10px 14px 0; }
  .cart-edit-status.visible,
  .menu-mutation-status.visible {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 30px;
    box-sizing: border-box;
    padding: 8px 10px;
    border: 1px solid #75bd8a66;
    border-radius: 14px;
    background: linear-gradient(135deg, #294a34b8, #17271dac);
    background-clip: padding-box;
    color: #b8e8c2;
    box-shadow: inset 0 1px 0 #ffffff1c, 0 8px 22px #00000020;
    -webkit-backdrop-filter: blur(12px) saturate(125%);
    backdrop-filter: blur(12px) saturate(125%);
    font-weight: 750;
  }
  .cart-edit-status:not(.visible),
  .menu-mutation-status:not(.visible) {
    display: none !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
  }
  .cart-edit-status.visible:not(.error)::before,
  .menu-mutation-status.visible:not(.error)::before {
    content: "";
    width: 11px;
    height: 11px;
    flex: none;
    box-sizing: border-box;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: cart-status-spin .75s linear infinite;
  }
  @keyframes cart-status-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .cart-edit-status.visible:not(.error)::before,
    .menu-mutation-status.visible:not(.error)::before { animation: none; }
  }
  .receipt-items { padding: 0 14px; }
  .receipt-items .receipt-row.item {
    margin: 0;
    padding: 13px 0;
    border-top: 1px solid #ffffff0d;
  }
  .receipt-items .receipt-row.item:first-child { border-top: 0; }
  .receipt-bill {
    margin: 0 14px;
    padding: 10px 11px;
    border: 1px solid #ffffff24;
    border-radius: 12px;
    background: #ffffff06;
    box-shadow: inset 0 1px 0 #ffffff0d;
  }
  .receipt-bill .receipt-row {
    align-items: baseline;
    margin: 0;
    padding: 3px 0;
  }
  .receipt-bill .subtotal {
    color: #e6e1d7;
    font-weight: 750;
  }
  .receipt .receipt-row.total {
    align-items: center;
    margin: 11px 14px 14px;
    padding: 11px 12px;
    border: 1px solid #ffffff28;
    border-radius: 12px;
    background: #ffffff09;
    box-shadow: inset 0 1px 0 #ffffff10;
  }
  .receipt .receipt-row.total strong:last-child {
    font-size: 19px;
    letter-spacing: -.35px;
  }
  .receipt .cart-limit-warning { margin: -3px 14px 14px; }
  .item-description > div {
    max-height: none;
    margin: 5px 0 0;
    padding: 7px 8px;
    overflow: visible;
    border-radius: 8px;
    background: #ffffff07;
    color: #aaa69c;
    font-size: 10px;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .promos {
    padding: 0;
    overflow: hidden;
    border-color: #ffffff28;
    box-shadow: inset 0 1px 0 #ffffff0e;
  }
  .promo-empty { padding: 13px; }
  .promos > summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 13px;
    border: 0;
    list-style: none;
  }
  .promos > summary::-webkit-details-marker { display: none; }
  .promos > summary .section-title { margin: 0; }
  .promos > summary small {
    display: block;
    margin-top: 3px;
    color: #8f8a81;
    font-size: 8.5px;
  }
  .promos > summary > i {
    width: 7px;
    height: 7px;
    flex: none;
    border-right: 1.5px solid currentColor;
    border-bottom: 1.5px solid currentColor;
    transform: rotate(45deg);
    transition: transform .18s;
  }
  .promos[open] > summary > i { transform: rotate(225deg); }
  .promos .promo-list {
    margin: 0;
    max-height: 226px;
    padding: 10px 9px 13px 13px;
    overflow-y: auto;
    border-top: 1px solid #ffffff12;
    scrollbar-gutter: stable;
    scrollbar-width: thin;
    scrollbar-color: #81786f transparent;
  }
  .promos .promo-list:focus-visible {
    outline: 2px solid #ff7043;
    outline-offset: -3px;
  }
  .promos .promo-list::-webkit-scrollbar { width: 7px; }
  .promos .promo-list::-webkit-scrollbar-thumb {
    border: 2px solid transparent;
    border-radius: 999px;
    background: #81786f;
    background-clip: padding-box;
  }
  .promo-list { display: grid; gap: 8px; }
  .promo-option {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    min-width: 0;
    padding: 11px;
    border: 1px solid #ffffff16;
    border-radius: 12px;
    background: #ffffff07;
    color: #f5f0e4;
    text-align: left;
  }
  .promo-option > span:first-child { min-width: 0; }
  .promo-option b { display: block; }
  .promo-option small {
    display: block;
    margin-top: 3px;
    color: #9a968c;
    font-size: 8.5px;
    line-height: 1.35;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .promo-option:not(:disabled):hover { border-color: #ff704370; }
  .promo-option:focus-visible {
    outline: 2px solid #ff7043;
    outline-offset: 2px;
  }
  .promo-option:disabled { opacity: .72; cursor: not-allowed; }
  .promo-option.selected {
    border-color: #3ba96866;
    background: #123a22;
  }
  .promo-badges {
    display: flex;
    flex: none;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
  }
  .promo-badges em,
  .promo-badges i {
    padding: 2px 5px;
    border-radius: 999px;
    font-size: 7px;
    font-style: normal;
    font-weight: 850;
    letter-spacing: .25px;
    white-space: nowrap;
  }
  .promo-badges em { background: #56320e; color: #ffc46a; }
  .promo-badges i { background: #1e5a37; color: #9cf0ad; }
  .agent-responses {
    isolation: isolate;
    max-height: 260px;
    margin: 18px 0 0;
    padding: 0 15px 15px;
    overflow: hidden auto;
    border: 1px solid #6d5cff33;
    border-radius: 18px;
    background: #171629;
    background-clip: padding-box;
    scrollbar-width: thin;
    scrollbar-color: #655bb0 transparent;
  }
  .agent-response-title {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 0 -15px;
    padding: 15px;
    border-radius: 17px 17px 0 0;
    background: #171629ef;
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
  }
  .agent-response-title > span {
    display: grid;
    place-items: center;
    width: 27px;
    height: 27px;
    flex: none;
    border-radius: 9px;
    background: #6d5cff24;
    color: #a89cff;
  }
  .agent-response-title small,
  .agent-response-title b { display: block; }
  .agent-response-title small {
    color: #9891dd;
    font-size: 7.5px;
    letter-spacing: 1.1px;
  }
  .agent-response-title b { font-size: 11px; }
  .agent-responses article {
    margin-top: 0;
    padding-top: 11px;
    border-top: 1px solid #ffffff0d;
    color: #aaa6bd;
    font-size: 10.5px;
  }
  .agent-responses article + article { margin-top: 11px; }
  .agent-responses article p { margin: 5px 0; }
  .agent-responses article:not(.latest) { opacity: .65; }
  .agent-responses article blockquote.agent-instruction {
    margin: 0 0 7px;
    padding: 0 2px;
    border: 0;
    background: transparent;
    color: #8f8a9f;
    font-size: 9px;
    font-weight: 500;
  }
  .agent-instruction > small,
  .agent-answer > small {
    display: block;
    margin-bottom: 3px;
    font-size: 7px;
    font-weight: 850;
    letter-spacing: .8px;
    text-transform: uppercase;
  }
  .agent-instruction > small { color: #777286; }
  .agent-answer {
    padding: 8px 10px;
    border: 1px solid #8c7dff55;
    border-left: 3px solid #8c7dff;
    border-radius: 8px;
    background: #8c7dff12;
    color: #e5e0f6;
  }
  .agent-answer > small { color: #a89cff; }
  .agent-answer p:first-of-type { margin-top: 0; }
  .agent-answer p:last-child { margin-bottom: 0; }
  .agent-question {
    display: flex;
    gap: 10px;
    padding-bottom: 13px;
    border-bottom: 1px solid #ffffff10;
  }
  .agent-question > span {
    width: 8px;
    height: 8px;
    flex: none;
    margin-top: 4px;
    border-radius: 50%;
    background: #ff7043;
    box-shadow: 0 0 0 4px #ff704322;
  }
  .agent-question > div { min-width: 0; }
  .agent-question > div > small {
    display: block;
    color: #ff8f6e;
    font-size: 8.5px;
    font-weight: 850;
    letter-spacing: 1.1px;
  }
  .agent-question-copy {
    margin-top: 6px;
    color: #d5d0c5;
    font-size: 11px;
    line-height: 1.5;
  }
  .agent-question-copy p { margin: 5px 0; }
  .agent-question-copy ol,
  .agent-question-copy ul {
    margin: 6px 0;
    padding-left: 18px;
  }
  .agent-question + .customize-form { margin-top: 13px; }
  .payment-icon-upi {
    width: 30px;
  }
  .agent-follow-up-form {
    display: grid;
    gap: 11px;
    margin-top: 13px;
  }
  .generated-field {
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }
  .generated-field > span,
  .generated-field legend {
    display: block;
    margin-bottom: 6px;
    color: #ded9cf;
    font-size: 10px;
    font-weight: 750;
  }
  .generated-field input[type="text"],
  .generated-field textarea,
  .generated-field select {
    box-sizing: border-box;
    width: 100%;
    border: 1px solid #ffffff18;
    border-radius: 11px;
    padding: 9px 10px;
    background: #0f0f0d99;
    color: #f8f5ea;
    font: 10px/1.4 Inter,Arial,sans-serif;
    outline: none;
  }
  .generated-options {
    display: grid;
    gap: 6px;
  }
  .generated-options label {
    display: grid;
    grid-template-columns: 16px minmax(0,1fr);
    align-items: center;
    gap: 8px;
    padding: 9px;
    border: 1px solid #ffffff10;
    border-radius: 11px;
    background: #ffffff06;
    cursor: pointer;
  }
  .generated-options input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .generated-options label > i {
    grid-column: 1;
    grid-row: 1;
    width: 13px;
    height: 13px;
    box-sizing: border-box;
    border: 1.5px solid #77736a;
    border-radius: 4px;
  }
  .generated-options input[type="radio"] + i { border-radius: 50%; }
  .generated-options input:checked + i {
    border: 4px solid #ff7043;
    background: #fff;
  }
  .generated-options label > span { grid-column: 2; }
  .generated-options b,
  .generated-options small { display: block; }
  .generated-options b { font-size: 9.5px; }
  .generated-options small { margin-top: 2px; color: #918d84; font-size: 8px; }
  .generated-submit {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    width: 100%;
    background: #ff6440;
    color: #fff;
  }
  .generated-submit svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .checkout-surface { margin-top: 16px; }
  .agent-composer { margin-bottom: 0; }
  :host([data-theme="light"]) { color-scheme: light; }
  :host([data-theme="dark"]) { color-scheme: dark; }
  :host([data-theme="light"]) aside {
    background: linear-gradient(155deg, #ffffffdc, #f8f8f4b3);
    color: #181814;
    border-color: #8f887b8f;
    box-shadow: 0 28px 90px #1b1b1845, inset 0 1px 0 #ffffffed;
    -webkit-backdrop-filter: blur(24px) saturate(135%);
    backdrop-filter: blur(24px) saturate(135%);
  }
  :host([data-theme="light"]) .eyebrow,
  :host([data-theme="light"]) .section-title,
  :host([data-theme="light"]) .restaurant-copy p,
  :host([data-theme="light"]) .receipt-row small,
  :host([data-theme="light"]) .receipt-row.muted,
  :host([data-theme="light"]) .markdown,
  :host([data-theme="light"]) .payment-options small,
  :host([data-theme="light"]) .payment-lede,
  :host([data-theme="light"]) .payment-note,
  :host([data-theme="light"]) .success-view p,
  :host([data-theme="light"]) .loading-copy { color: #716f65; }
  :host([data-theme="light"]) .receipt,
  :host([data-theme="light"]) .promos {
    background: #ffffff73;
    border-color: #81786ba3;
    box-shadow: inset 0 1px 0 #ffffff, 0 9px 26px #28282020;
  }
  :host([data-theme="light"]) .receipt .section-title-row,
  :host([data-theme="light"]) .receipt-items .receipt-row.item {
    border-color: #18181412;
  }
  :host([data-theme="light"]) .promos .promo-list {
    border-color: #18181416;
    scrollbar-color: #8d8376 transparent;
  }
  :host([data-theme="light"]) .receipt-bill {
    background: #ffffff8f;
    border-color: #9b918275;
    box-shadow: inset 0 1px 0 #ffffff;
  }
  :host([data-theme="light"]) .receipt-bill .subtotal { color: #292820; }
  :host([data-theme="light"]) .deal {
    border: 1px solid #64a979;
    background: #e2f5e7;
    color: #176733;
    box-shadow: inset 0 1px 0 #ffffff, 0 3px 10px #216f3620;
  }
  :host([data-theme="light"]) .receipt-row.discount {
    color: #176c38;
    font-weight: 750;
  }
  :host([data-theme="light"]) .receipt .receipt-row.total {
    background: #fff7ed;
    border-color: #b8a995;
    box-shadow: inset 0 1px 0 #ffffff, 0 5px 16px #49331c12;
  }
  :host([data-theme="light"]) .rule,
  :host([data-theme="light"]) details,
  :host([data-theme="light"]) .actions { border-color: #18181414; }
  :host([data-theme="light"]) .rule { background: #18181414; }
  :host([data-theme="light"]) .delivery {
    border-color: #927d65c7;
    background: linear-gradient(145deg, #fffaf3d4, #eadbcbbb);
    box-shadow:
      inset 0 1px 0 #ffffff,
      inset 0 -1px 0 #9e876c42,
      0 10px 26px #49331c1f;
  }
  :host([data-theme="light"]) .delivery small { color: #6f6255; }
  :host([data-theme="light"]) .delivery b { color: #282119; }
  :host([data-theme="light"]) summary { color: #4c4941; }
  :host([data-theme="light"]) .quiet,
  :host([data-theme="light"]) .quiet-link {
    background: #1818140c;
    color: #4c4941;
  }
  :host([data-theme="light"]) .restaurant-logo,
  :host([data-theme="light"]) .receipt-item-image,
  :host([data-theme="light"]) .menu-item-image,
  :host([data-theme="light"]) .menu-image-fallback {
    background: #eee6da;
    border-color: #18181414;
  }
  :host([data-theme="light"]) .item-description > div,
  :host([data-theme="light"]) .quantity-control button,
  :host([data-theme="light"]) .promo-option,
  :host([data-theme="light"]) .menu-list article,
  :host([data-theme="light"]) .payment-options label,
  :host([data-theme="light"]) .payment-status {
    background: #18181408;
    border-color: #18181414;
    color: #39362f;
  }
  :host([data-theme="light"]) .item-description summary,
  :host([data-theme="light"]) .item-description > div,
  :host([data-theme="light"]) .menu-list small,
  :host([data-theme="light"]) .promo-option small { color: #716f65; }
  :host([data-theme="light"]) .product-rating,
  :host([data-theme="light"]) .menu-item-rating {
    background: #e3f5ee;
    color: #24745e;
  }
  :host([data-theme="light"]) .product-rating small,
  :host([data-theme="light"]) .menu-item-rating small { color: inherit!important; }
  :host([data-theme="light"]) .open-menu {
    border-color: #d85c3b;
    background: #fff0e9;
    color: #a93820;
    box-shadow: inset 0 1px 0 #ffffff, 0 3px 10px #c14e2920;
  }
  :host([data-theme="light"]) .menu-list strong,
  :host([data-theme="light"]) .promo-option b,
  :host([data-theme="light"]) .agent-events li.active { color: #292820; }
  :host([data-theme="light"]) .promo-option.selected { background: #e5f4e8; }
  :host([data-theme="light"]) .promo-badges .best-match {
    border: 1px solid #d49a39;
    background: #fff1d2;
    color: #774300;
  }
  :host([data-theme="light"]) .promo-badges .online-payment {
    border: 1px solid #b78a55;
    background: #f7ead9;
    color: #68441d;
  }
  :host([data-theme="light"]) .promo-badges .not-eligible {
    border: 1px solid #a98f70;
    background: #eee4d7;
    color: #644927;
  }
  :host([data-theme="light"]) .promo-badges .selected-badge {
    border: 1px solid #58a270;
    background: #dff3e5;
    color: #176537;
  }
  :host([data-theme="light"]) .quantity-control { border-color: #18181418; }
  :host([data-theme="light"]) .quantity-control button { color: #181814; }
  :host([data-theme="light"]) .agent-responses {
    background: #f1efff;
    border-color: #7869d533;
    background-clip: padding-box;
  }
  :host([data-theme="light"]) .agent-response-title { background: #f1efffef; }
  :host([data-theme="light"]) .agent-responses article {
    color: #656077;
    border-color: #1818140d;
  }
  :host([data-theme="light"]) .agent-responses article blockquote {
    background: transparent;
    color: #716b7e;
  }
  :host([data-theme="light"]) .agent-answer {
    border-color: #7665d866;
    border-left-color: #7665d8;
    background: #ffffffa8;
    color: #383248;
    box-shadow: inset 0 1px 0 #ffffff, 0 5px 15px #4b3fa414;
  }
  :host([data-theme="light"]) .agent-answer > small { color: #6555c2; }
  :host([data-theme="light"]) .payment-options label {
    border-color: #9d9487;
    background: #fffdf9c9;
    color: #302d27;
    box-shadow: inset 0 1px 0 #ffffff, 0 4px 14px #28282012;
  }
  :host([data-theme="light"]) .payment-options label:hover {
    border-color: #d45b3d;
    background: #fff4ee;
  }
  :host([data-theme="light"]) .payment-options label:has(input:checked) {
    border-color: #d64f2f;
    background: #fff0e8;
    box-shadow: 0 0 0 2px #d64f2f2e, inset 0 1px 0 #ffffff;
  }
  :host([data-theme="light"]) .payment-options b { color: #302d27; }
  :host([data-theme="light"]) .payment-options small { color: #615c53; }
  :host([data-theme="light"]) .payment-icon {
    border: 1px solid #c9bfb2;
    background: #f5ede5;
    color: #c64a2e;
  }
  :host([data-theme="light"]) .payment-icon-upi {
    background: #f5ede5;
    color: #c64a2e;
  }
  :host([data-theme="light"]) .agent-composer {
    background: #fff9f58c;
    border-color: #9b8c8175;
    box-shadow: inset 0 1px 0 #ffffffed, 0 8px 24px #28282016;
  }
  :host([data-theme="light"]) .agent-question { border-color: #18181410; }
  :host([data-theme="light"]) .agent-question-copy,
  :host([data-theme="light"]) .customize-form > label { color: #4c443e; }
  :host([data-theme="light"]) .customize-form textarea,
  :host([data-theme="light"]) .menu-search input {
    background: #fff;
    color: #181814;
    border-color: #d9d1c2;
  }
  :host([data-theme="light"]) .customize-form textarea::placeholder,
  :host([data-theme="light"]) .menu-search input::placeholder { color: #8b8579; }
  :host([data-theme="light"]) .cart-editor-dialog,
  :host([data-theme="light"]) .item-image-lightbox {
    background: #ffffffd3;
    color: #181814;
    border-color: #8f887b8f;
    box-shadow: 0 30px 100px #1b1b184d, inset 0 1px 0 #ffffffed;
    -webkit-backdrop-filter: blur(24px) saturate(130%);
    backdrop-filter: blur(24px) saturate(130%);
  }
  :host([data-theme="light"]) .generated-field > span,
  :host([data-theme="light"]) .generated-field legend,
  :host([data-theme="light"]) .generated-options b { color: #292820; }
  :host([data-theme="light"]) .generated-options label {
    background: #ffffff80;
    border-color: #625d5340;
  }
  :host([data-theme="light"]) .generated-field input[type="text"],
  :host([data-theme="light"]) .generated-field textarea,
  :host([data-theme="light"]) .generated-field select {
    background: #ffffff99;
    color: #181814;
    border-color: #625d5352;
  }
  :host([data-theme="light"]) .dialog-close {
    background: #1818140c;
    color: #716f65;
  }
  :host([data-theme="light"]) .dialog-cancel {
    border: 1px solid #9b9182;
    background: #e8e1d7;
    color: #4a433a;
    box-shadow: inset 0 1px 0 #ffffff, 0 4px 12px #28282018;
  }
  :host([data-theme="light"]) .dialog-cancel:hover {
    border-color: #817667;
    background: #ddd4c8;
    color: #302b25;
  }
  :host([data-theme="light"]) .cart-editor-dialog p { color: #716f65; }
  :host([data-theme="light"]) .menu-search button,
  :host([data-theme="light"]) .menu-add,
  :host([data-theme="light"]) .payment-options label:has(input:checked) { background: #fff0e8; }
  :host([data-theme="light"]) .menu-mutation-status.error,
  :host([data-theme="light"]) .cart-edit-status.error {
    background: #ffe7df;
    color: #8f2918;
    border: 1px solid #e58c78;
  }
  :host([data-theme="light"]) .menu-mutation-status.visible:not(.error),
  :host([data-theme="light"]) .cart-edit-status.visible:not(.error) {
    background: linear-gradient(135deg, #effaf2c9, #dcefe1b8);
    color: #1e6538;
    border-color: #72ad83;
    box-shadow: inset 0 1px 0 #ffffff, 0 8px 22px #216f3618;
    -webkit-backdrop-filter: blur(14px) saturate(120%);
    backdrop-filter: blur(14px) saturate(120%);
  }
  :host([data-theme="light"]) .cancel-payment {
    background: #fff0eb;
    color: #9f2f1f;
    border-color: #dc6b57;
  }
  :host([data-theme="light"]) .cancel-payment:hover {
    background: #ffe2d9;
    color: #7e2115;
  }
  :host([data-theme="light"]) .menu-filters button,
  :host([data-theme="light"]) .menu-filters select,
  :host([data-theme="light"]) .option-groups fieldset {
    background: #18181408;
    color: #4c4941;
    border-color: #18181414;
  }
  :host([data-theme="light"]) .menu-filters button.active {
    background: #fff0e8;
    color: #c74d2d;
    border-color: #ff70434f;
  }
  :host([data-theme="light"]) .option-groups legend { color: #292820; }
  :host([data-theme="light"]) .option-groups label { border-color: #1818140d; }
  :host([data-theme="light"]) .menu-options .dialog-actions { background: #fffaf2ef; }
  :host([data-theme="light"]) .payment-icon { background: #ff704312; }
  :host([data-theme="light"]) .food-update { background: #ffe6dc; }
  :host([data-theme="light"]) .success-mark { background: #dff2e4; }
  :host([data-theme="light"]) .notice-mark { background: #f7e3dd; }
`;
