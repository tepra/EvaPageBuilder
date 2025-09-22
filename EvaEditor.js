(function (global) {
  "use strict";

  function EvaPageBuilderInstance(userOptions = {}) {
    // --- Private state ---
    const publicAPI = {};

    let iframe = null;
    let iframeDoc = null;
    let queue = [];
    let selectedElement = null;
    let previousSelectedElement = null;
    let draggedElement = null;
    let undoStack = [];
    let redoStack = [];
    let highlightTarget = null;

    let popoverRAF = null; // Keep reference to animation frame
    let popoverEl = null; // Popover element for this instance

    const originalImagePositionMap = new WeakMap();

    const blocks = [];
    const defaultOptions = {
      container: "#evaBuilder",
      domainPath: "",
      frameConfig: {
        css: [],
        js: [],
        jsOnBody: [],
        backgroundColor: "#fff",
      },
      sidebarSelector: {
        container: null,
        deviceSwitcher: {},
      },
      codeEditor: {
        readOnly: [],
        editable: [],
      },
      defaultSelectedElement: null,
      actionBtn: {
        save: false,
        delete: false,
        clear: false,
      },
      onDeviceSwitch: () => {},
      onLoad: () => {},
    };

    const options = Object.assign({}, defaultOptions, userOptions);

    // --- Block readonly ---
    function isReadOnlyElement(el) {
      if (!el || !options.codeEditor.readOnly) return false;

      return options.codeEditor.readOnly.some(selector => {
        try {
          return el.matches(selector) || el.closest(selector);
        } catch (e) {
          return false;
        }
      });
    }


    const container = document.querySelector(options.container);
    if (!container) {
      console.warn(`Container ${options.container} not found.`);
      return;
    }

    // --- Frame Container ---
    const frameWrapper = container.querySelector(".eva-builder-frame");
    if (!frameWrapper) {
      console.warn("EvaBuilder: .eva-builder-frame not found inside container!");
      return;
    }

    injectMenuContent(); // Inject toolbar/menu automatically
    toggleActionButtonsVisibility();
    setupSidebarToggle();

    // --- Create and inject iframe ---
    iframe = document.createElement("iframe");
    iframe.style.width = "100%";
    iframe.style.height = "100%";
    iframe.style.border = "none";
    iframe.style.backgroundColor = options.frameConfig.backgroundColor;
    frameWrapper.appendChild(iframe);
    iframe.onload = async function () {
      iframeDoc = iframe.contentDocument || iframe.contentWindow.document;

      iframeDoc.open();
      iframeDoc.write(`<!DOCTYPE html><html><head><base href="${options.domainPath || window.location.origin}/"></head><body></body></html>`);
      iframeDoc.close();

      const undoBtn = container.querySelector('[eva-builder="undo"]');
      const redoBtn = container.querySelector('[eva-builder="redo"]');

      if (undoBtn) undoBtn.addEventListener("click", undo);
      if (redoBtn) redoBtn.addEventListener("click", redo);

      // Wait for assets to finish loading
      await loadAssets();
      setupDeviceSwitcher();

      const styleBtn = container.querySelector('[eva-builder="style"]');
      if (styleBtn) {
        styleBtn.addEventListener("click", () => {
          styleBtn.classList.toggle("active");

          const existingPanel = document.querySelector("#styleEditorPanel");
          if (existingPanel) {
            existingPanel.remove();
          } else {
            showStyleEditorPanel();
          }
        });
      }

      const codeBtn = container.querySelector('[eva-builder="code"]');
      if (codeBtn) {
        codeBtn.addEventListener("click", () => {
          showCodeEditorModal();
        });
      }

      const borderBtn = container.querySelector('[eva-builder="border"]');
      if (borderBtn) {
        borderBtn.addEventListener("click", () => {
          toggleShowBorder();
          borderBtn.classList.toggle("active");
        });
      }

      enableInternalDragDrop();
      enableEditing();
      setupFullscreenToggle();

      iframeDoc.body.style.backgroundColor = options.frameConfig.backgroundColor || "#fff";

      if (options.defaultSelectedElement) {
        setTimeout(() => {
          const defaultElement = iframeDoc.querySelector(options.defaultSelectedElement);
          if (defaultElement) {
            highlightSelectedElement(defaultElement);
          } else {
            console.warn(`EvaBuilder: Default selected element (${options.defaultSelectedElement}) not found in iframe.`);
          }
        }, 300);
      }

      iframeDoc.addEventListener("click", (e) => {
        const defaultElement = iframeDoc.querySelector(options.defaultSelectedElement);
        if (defaultElement) highlightSelectedElement(defaultElement);
      });

      iframeDoc.body.addEventListener("dragover", (e) => e.preventDefault());
      iframeDoc.body.addEventListener("drop", (e) => {
        e.preventDefault();

        const blockIndex = e.dataTransfer.getData("eva/block-index");
        const block = blocks[parseInt(blockIndex)];

        if (block && block.content) {
          const html = renderBlockContent(block.content);
          const target = selectedElement || iframeDoc.body;
          target.insertAdjacentHTML("beforeend", html);

          if (block.content.type === "img") {
            const newImg = target.querySelector("img:last-of-type");

            if (typeof window.EvaFileMan?.openColaborated === "function") {
              window.EvaFileMan.openColaborated((selectedPath) => {
                if (newImg && selectedPath) newImg.src = selectedPath;
              });
            }
          }

          saveState();
        }
      });

      if (typeof options.onLoad === "function") {
        options.onLoad(iframe, iframeDoc);
      }

      flushQueue();

      // Wait for the JsOn Body run to complete
      await runJsOnBody();

      flushQueue(); // if needed after jsOnBody
    };

    // --- Load CSS & JS into iframe ---
    function loadAssets() {
      const head = iframeDoc.head;
      const body = iframeDoc.body;
      const loadCSS = options.frameConfig.css.map(href => {
        return new Promise(res => {
          const link = iframeDoc.createElement("link");
          link.rel = "stylesheet";
          link.href = href;
          link.onload = res;
          head.appendChild(link);
        });
      });

      const loadJS = options.frameConfig.js.map(src => {
        return new Promise(res => {
          const script = iframeDoc.createElement("script");
          script.src = src;
          script.onload = res;
          body.appendChild(script);
        });
      });

      return Promise.all([...loadCSS, ...loadJS]);
    }

    // --- Additional config ---
    async function runJsOnBody() {
      const jsBody = options.frameConfig.jsOnBody || [];
      const context = iframe.contentWindow;
      const log = {
        info: (msg) => console.log(`[EvaEditor:jsOnBody] ${msg}`),
        warn: (msg) => console.warn(`[EvaEditor:jsOnBody] ${msg}`),
        error: (msg, err) => console.error(`[EvaEditor:jsOnBody] ${msg}`, err),
      };
      const loadScript = (src) => {
        return new Promise((resolve) => {
          const script = iframeDoc.createElement("script");
          script.src = src;
          script.onload = () => {
            resolve();
          };
          script.onerror = () => {
            log.warn(`Failed to load script: ${src}`);
            resolve();
          };
          iframeDoc.body.appendChild(script);
        });
      };
      const executeFunction = (fn) => {
        return new Promise((resolve) => {
          try {
            fn.call(context);
            log.info("Inline function executed.");
          } catch (err) {
            log.error("Error executing inline function:", err);
          }
          resolve();
        });
      };

      for (const item of jsBody) {
        if (typeof item === "string") {
          await loadScript(item);
        } else if (typeof item === "function") {
          await executeFunction(item);
        } else {
          log.warn(`Unsupported jsOnBody item type: ${typeof item}`);
        }
      }

      initializeInFrameLibraries(context);
    }

    function initializeInFrameLibraries(win) {
      const log = {
        info: (msg) => console.log(`[EvaEditor:init] ${msg}`),
        warn: (msg) => console.warn(`[EvaEditor:init] ${msg}`),
      };

      try {
        if (win?.AOS) {
          win.AOS.init();
        } else {
          log.warn("AOS not found.");
        }

        if (win?.PureCounter) new win.PureCounter();
      } catch (err) {
        console.error("[EvaEditor:init] Initialization error:", err);
      }
    }

    // --- Inject toolbar/menu ---
    function injectMenuContent() {
      const menu = container.querySelector(".eva-builder-menu");
      if (!menu) {
        console.warn("EvaBuilder: #app-builder-menu not found, skipping menu content injection.");
        return;
      }

      if (menu.children.length > 0) {
        console.log("EvaBuilder: #app-builder-menu already has content, skipping injection.");
        return;
      }

      menu.innerHTML = `
        <div class="card-body border-bottom d-flex justify-content-between align-items-center p-3">
          <a href="#" id="sidebarToggle" class="me-2 btn btn-sm btn-outline-dark">
            <i class="bx bx-sidebar fs-6"></i>
          </a>
          <div class="col d-flex justify-content-between align-items-center overflow-auto">
            <div class="d-none d-lg-block me-6">
              <div class="btn-group" role="group" aria-label="screen-switch">
                <button type="button" class="btn btn-sm btn-outline-dark" eva-builder-switch="smartphone-portrait">
                  <i class="bx bx-mobile fs-6"></i>
                </button>
                <button type="button" class="btn btn-sm btn-outline-dark" eva-builder-switch="smartphone-landscape">
                  <i class="bx bx-mobile fs-6 rotate-90"></i>
                </button>
                <button type="button" class="btn btn-sm btn-outline-dark active" eva-builder-switch="desktop">
                  <i class="bx bx-desktop fs-6"></i>
                </button>
              </div>
            </div>
            <div class="col d-flex justify-content-between align-items-center">
              <div class="btn-group me-6" role="group" aria-label="screen-panel">
                <button type="button" class="btn btn-sm btn-outline-dark" eva-builder="fullscreen">
                  <i class="bx bx-fullscreen fs-6"></i>
                </button>
                <button type="button" class="btn btn-sm btn-outline-dark" eva-builder="code">
                  <i class="bx bx-code-alt fs-6"></i>
                </button>
                <button type="button" class="btn btn-sm btn-outline-dark" eva-builder="style">
                  <i class="bx bx-brush fs-6"></i>
                </button>
                <button type="button" class="btn btn-sm btn-outline-dark" eva-builder="border">
                  <i class="bx bx-border-none fs-6"></i>
                </button>
              </div>
              <div class="col d-flex justify-content-between">
                <div class="btn-group" role="group" aria-label="screen-main-panel">
                  <button type="button" class="btn btn-sm btn-outline-dark" eva-builder="undo">
                    <i class="bx bx-undo fs-6"></i>
                  </button>
                  <button type="button" class="btn btn-sm btn-outline-dark" eva-builder="redo">
                    <i class="bx bx-redo fs-6"></i>
                  </button>
                  <button type="button" class="btn btn-sm btn-outline-dark" eva-builder="clear">
                    <i class="bx bx-eraser fs-6"></i>
                  </button>
                </div>
                <div class="btn-group" role="group" aria-label="screen-main-panel">
                  <button type="button" class="btn btn-sm btn-danger" eva-builder="delete">
                    <i class="bx bx-trash fs-6"></i>
                  </button>
                  <button type="button" class="btn btn-sm btn-primary" eva-builder="save">
                    <i class="bx bx-save fs-6"></i>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    // --- SideBar toggle & add Blocks ---
    function setupSidebarToggle() {
      const toggleBtn = container.querySelector("#sidebarToggle");
      const sidebar = container.querySelector(".eva-builder-sidebar");
      if (!toggleBtn || !sidebar) {
        console.warn("EvaBuilder: Sidebar toggle or sidebar container not found.");
        return;
      }

      toggleBtn.addEventListener("click", (e) => {
        e.preventDefault();
        sidebar.classList.toggle("show");
        toggleBtn.classList.toggle("active");

        // Sinkronisasi
        const rightCol = container.querySelector("#evaBuilder-foot .row .col:nth-child(2)");
        if (rightCol && sidebar) {
          const height = rightCol.offsetHeight;
          sidebar.style.height = `${height}px`;
          sidebar.style.overflow = "auto";
        }
      });
    }

    // --- Device Switcher ---
    function setupDeviceSwitcher(initialDevice = "desktop") {
      const defaultDevices = {
        desktop: { width: "100%", height: "auto" },
        "smartphone-portrait": { width: "375px", height: "667px" },
        "smartphone-landscape": { width: "667px", height: "375px" },
      };

      const devices = Object.assign({}, defaultDevices, options.sidebarSelector.deviceSwitcher);
      const buttons = container.querySelectorAll("[eva-builder-switch]");

      // Apply initial/default device config
      if (devices[initialDevice]) {
        const device = devices[initialDevice];

        iframe.style.width = device.width || "100%";
        iframe.style.height = device.height || "auto";

        // Mark initial button as active
        buttons.forEach(btn => {
          const type = btn.getAttribute("eva-builder-switch");
          btn.classList.toggle("active", type === initialDevice);
        });

        if (typeof options.onDeviceSwitch === "function") {
          options.onDeviceSwitch(initialDevice, iframe, iframeDoc);
        }
      }

      buttons.forEach(button => {
        button.addEventListener("click", e => {
          const type = button.getAttribute("eva-builder-switch");
          const config = devices[type];
          if (!config) return;

          iframe.style.width = config.width || "100%";
          iframe.style.height = config.height || "auto";

          if (typeof options.onDeviceSwitch === "function") {
            options.onDeviceSwitch(type, iframe, iframeDoc);
          }

          buttons.forEach(btn => btn.classList.remove("active"));
          button.classList.add("active");
        });
      });
    }

    // --- Popover ---
    function createPopover() {
      if (popoverEl) return;

      popoverEl = document.createElement("div");
      popoverEl.classList.add("eva-toolbar-popover");
      popoverEl.setAttribute("data-parent", `${options.container}`);
      popoverEl.style.position = 'fixed';
      popoverEl.style.display = 'none';

      // Default toolbar content
      setPopoverContent("default");

      document.body.appendChild(popoverEl);

      popoverEl.addEventListener("click", (e) => {
        e.stopPropagation();

        const btn = e.target.closest("button[data-action]");
        if (!btn || !selectedElement) return;

        const action = btn.getAttribute("data-action");

        if (action === "duplicate") {
          const targetToDuplicate = selectedElement.closest("li") || selectedElement;
          const clone = targetToDuplicate.cloneNode(true);

          clone.classList.add("eva-cloned");
          targetToDuplicate.insertAdjacentElement("afterend", clone);

          enableEditingFor(clone);
          highlightSelectedElement(clone);
          injectClonedStyle();
          clone.scrollIntoView({ behavior: "smooth", block: "center" });
          saveState();
        }

        if (action === "edit-link") {
          let linkModal = document.getElementById("editLinkModal");

          if (!linkModal) {
            linkModal = document.createElement("div");
            linkModal.className = "modal fade";
            linkModal.id = "editLinkModal";
            linkModal.setAttribute("data-bs-backdrop", "static");
            linkModal.setAttribute("data-bs-keyboard", "false");
            linkModal.tabIndex = -1;
            linkModal.innerHTML = `
              <div class="modal-dialog modal-dialog-centered" role="document">
                <div class="modal-content">
                  <div class="modal-header">
                    <h6 class="modal-title fw-bold mb-0">Edit Link</h6>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                  </div>
                  <div class="modal-body">
                    <div class="mb-3">
                      <label for="evaLinkHref" class="form-label">URL</label>
                      <input type="text" class="form-control" id="evaLinkHref" placeholder="https://...">
                    </div>
                    <div class="mb-3">
                      <label for="evaLinkText" class="form-label">Teks</label>
                      <input type="text" class="form-control" id="evaLinkText" placeholder="Link Text">
                    </div>
                  </div>
                  <div class="modal-footer">
                    <button type="button" class="btn btn-sm btn-secondary" data-bs-dismiss="modal">Cancel</button>
                    <button type="button" id="evaLinkSaveBtn" class="btn btn-sm btn-primary">Apply</button>
                  </div>
                </div>
              </div>
            `;

            document.body.appendChild(linkModal);
          }

          const hrefInput = document.getElementById("evaLinkHref");
          const textInput = document.getElementById("evaLinkText");
          hrefInput.value = selectedElement.getAttribute("href") || "";
          textInput.value = selectedElement.textContent || "";

          const bsModal = new bootstrap.Modal(linkModal);
          bsModal.show();

          linkModal.addEventListener("shown.bs.modal", () => {
            // You can customize here if needed...
            const customizer = document.getElementById("template-customizer");
            if (customizer) {
              customizerToHide();
              overFlowPageHide();
            }
          });

          const saveBtn = document.getElementById("evaLinkSaveBtn");
          saveBtn.onclick = () => {
            selectedElement.setAttribute("href", hrefInput.value);
            selectedElement.textContent = textInput.value;

            saveState();
            bsModal.hide();
          };

          linkModal.addEventListener("hidden.bs.modal", () => {
            linkModal.remove();

            // You can customize here if needed...
            customizerResetFromHide();
            overflowPageNormal();
          });
        }

        if (action === 'edit-icon') {
          let linkModal = document.getElementById("editLinkModal");

          if (!linkModal) {
            linkModal = document.createElement("div");
            linkModal.className = "modal fade";
            linkModal.id = "editLinkModal";
            linkModal.setAttribute("data-bs-backdrop", "static");
            linkModal.setAttribute("data-bs-keyboard", "false");
            linkModal.tabIndex = -1;
            linkModal.innerHTML = `
              <div class="modal-dialog modal-dialog-centered" role="document">
                <div class="modal-content">
                  <div class="modal-header">
                    <h6 class="modal-title fw-bold mb-0">Edit Icon</h6>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                  </div>
                  <div class="modal-body">
                    <div class="mb-6">
                      <label for="evaIconClass" class="form-label">Icon ClassName</label>
                      <input type="text" class="form-control" id="evaIconClass" placeholder="...">
                    </div>
                    <div class="mb-3">
                      <p>For more information, please refer to the <a href="https://icons.getbootstrap.com/" target="_blank" rel="noopener">official icon documentation</a></p>
                    </div>
                  </div>
                  <div class="modal-footer">
                    <button type="button" class="btn btn-sm btn-secondary" data-bs-dismiss="modal">Cancel</button>
                    <button type="button" id="evaLinkSaveBtn" class="btn btn-sm btn-primary">Apply</button>
                  </div>
                </div>
              </div>
            `;

            document.body.appendChild(linkModal);
          }

          const iconInput = document.getElementById("evaIconClass");
          iconInput.value = selectedElement.getAttribute("class") || "";

          const bsModal = new bootstrap.Modal(linkModal);
          bsModal.show();

          linkModal.addEventListener("shown.bs.modal", () => {
            // You can customize here if needed...
            const customizer = document.getElementById("template-customizer");
            if (customizer) {
              customizerToHide();
              overFlowPageHide();
            }
          });

          const saveBtn = document.getElementById("evaLinkSaveBtn");
          saveBtn.onclick = () => {
            selectedElement.setAttribute("class", iconInput.value);
            saveState();
            bsModal.hide();
          };

          linkModal.addEventListener("hidden.bs.modal", () => {
            linkModal.remove();
            // You can customize here if needed...
            customizerResetFromHide();
            overflowPageNormal();
          });
        }

        if (action === "copy-link") {
          navigator.clipboard.writeText(selectedElement.outerHTML);
        }

        if (action === "delete") {
          const isImage = selectedElement.tagName === "IMG";
          const isWrapper = selectedElement.classList.contains("resize-wrapper");

          if (isImage || isWrapper) {
            removeResizeWrapper(selectedElement);
          } else {
            selectedElement.remove();
          }

          selectedElement = null;
          previousSelectedElement = null;
          popoverEl.style.display = "none";
          closeStyleManager();
          saveState();
        }
      });

      function setPopoverContent(mode) {
        if (!popoverEl) return;
        if (mode === "link") {
          popoverEl.innerHTML = `
            <div class="btn-group eva-popover-actions">
              <button type="button" class="btn btn-sm btn-warning" data-action="edit-link">
                <i class="bx bx-pencil"></i>
              </button>
              <button type="button" class="btn btn-sm btn-info" data-action="copy-link">
                <i class="bx bx-copy"></i>
              </button>
              <button type="button" class="btn btn-sm btn-danger" data-action="delete">
                <i class="bx bx-x"></i>
              </button>
            </div>
          `;
        } else if (mode === 'icon') {
          popoverEl.innerHTML = `
            <div class="btn-group eva-popover-actions">
              <button type="button" class="btn btn-sm btn-warning" data-action="edit-icon">
                <i class="bx bx-brush"></i>
              </button>
              <button type="button" class="btn btn-sm btn-info" data-action="copy-link">
                <i class="bx bx-copy"></i>
              </button>
              <button type="button" class="btn btn-sm btn-danger" data-action="delete">
                <i class="bx bx-x"></i>
              </button>
            </div>
          `;
        } else {
          popoverEl.innerHTML = `
            <div class="btn-group eva-popover-actions">
              <button type="button" class="btn btn-sm btn-info" data-action="duplicate">
                <i class="bx bx-copy"></i>
              </button>
              <button type="button" class="btn btn-sm btn-danger" data-action="delete">
                <i class="bx bx-x"></i>
              </button>
            </div>
          `;
        }
      }

      // Expose for external use
      publicAPI.setPopoverContent = setPopoverContent;
    }

    function updatePopoverPositionLoop() {
      if (!selectedElement || !popoverEl) return;

      const selectedRect = selectedElement.getBoundingClientRect();
      const iframeRect = iframe.getBoundingClientRect();

      // If iframeRect.height == 0 → possible iframe hidden/bug in fullscreen
      if (iframeRect.height === 0 || iframeRect.width === 0) {
        stopPopoverTracking(); // Avoid empty loop
        return;
      }

      const popoverWidth = popoverEl.offsetWidth;
      const popoverHeight = popoverEl.offsetHeight;

      // Calculate absolute position relative to window (not iframe)
      let left = iframeRect.left + selectedRect.left + (selectedRect.width / 2) - (popoverWidth / 2);
      let top = iframeRect.top + selectedRect.top - popoverHeight - 8;

      // When space not enough, then move to below element
      if (top < 10) {
        top = iframeRect.top + selectedRect.bottom + 8;
      }

      // Clamp into viewport
      left = Math.max(8, Math.min(left, window.innerWidth - popoverWidth - 8));
      top = Math.max(8, Math.min(top, window.innerHeight - popoverHeight - 8));

      // Check whether the popover is still in the iframe area
      const popoverRect = {
        top,
        left,
        right: left + popoverWidth,
        bottom: top + popoverHeight
      };

      const iframeBounds = iframe.getBoundingClientRect();
      const isPopoverOutsideIframe =
        popoverRect.bottom < iframeBounds.top ||
        popoverRect.top > iframeBounds.bottom ||
        popoverRect.right < iframeBounds.left ||
        popoverRect.left > iframeBounds.right;

      if (isPopoverOutsideIframe) {
        popoverEl.style.display = "none";
      } else {
        popoverEl.style.left = `${left}px`;
        popoverEl.style.top = `${top}px`;
        popoverEl.style.display = "block";
      }

      popoverRAF = requestAnimationFrame(updatePopoverPositionLoop);
    }

    function startPopoverTracking() {
      stopPopoverTracking();
      createPopover();
      updatePopoverPositionLoop();
    }

    function stopPopoverTracking() {
      if (popoverRAF) {
        cancelAnimationFrame(popoverRAF);
        popoverRAF = null;
      }
      if (popoverEl) {
        popoverEl.style.display = "none";
      }
    }

    function injectClonedStyle() {
      if (!iframeDoc.querySelector("style[data-eva-cloned]")) {
        const style = iframeDoc.createElement("style");
        style.setAttribute("data-eva-cloned", "true");
        style.textContent = `
          .eva-cloned {
            outline: 2px dashed limegreen !important;
          }
        `;
        iframeDoc.head.appendChild(style);
      }
    }

    function enableEditingFor(el) {
      if (isReadOnlyElement(el)) return;

      const tag = el.tagName.toLowerCase();
      const editableTags = ["label", "span", "p", "h1", "h2", "h3", "span", "div", "a", "td", "th", "button", "ul", "li"];
      if (editableTags.includes(tag)) {
        el.setAttribute("contenteditable", "true");
      }

      el.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        highlightSelectedElement(el);
      });

      // el.addEventListener("dblclick", (e) => {
      //   const tag = el.tagName.toLowerCase();

      //   if (editableTags.includes(tag)) {
      //     el.setAttribute("contenteditable", "true");
      //     el.focus();
      //   }
      // });

      el.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (tag === "img") {
          if (typeof window.EvaFileMan?.openColaborated === "function") {
            window.EvaFileMan.openColaborated((selectedPath) => {
              if (selectedPath) {
                el.src = selectedPath;
                if (typeof saveState === "function") saveState();
              }
            });
          }
          return;
        }

        if (editableTags.includes(tag)) {
          el.setAttribute("contenteditable", "true");
          el.focus();
        }
      });

      // If you have children, recursive setup
      el.querySelectorAll("*").forEach(child => enableEditingFor(child));
    }

    // --- Enable Editing / Selection ---
    function enableEditing() {
      iframeDoc.body.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        highlightSelectedElement(e.target);
      });

      iframeDoc.body.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();

        const el = e.target;
        if (isReadOnlyElement(el)) return;

        const tag = el.tagName.toLowerCase();
        const editableTags = ["label", "span", "p", "h1", "h2", "h3", "span", "div", "a", "td", "th", "button"];

        // if (tag === "img" && el.dataset.editable === "true") {
        //   if (typeof window.EvaFileMan?.openColaborated === "function") {
        //     window.EvaFileMan.openColaborated((selectedPath) => {
        //       if (selectedPath) {
        //         el.src = selectedPath;
        //         if (typeof saveState === "function") saveState();
        //       }
        //     });
        //   }

        //   return;
        // }

        if (tag === "img") {
          if (typeof window.EvaFileMan?.openColaborated === "function") {
            window.EvaFileMan.openColaborated((selectedPath) => {
              if (selectedPath) {
                el.src = selectedPath;
                if (typeof saveState === "function") saveState();
              }
            });
          }
          return;
        }

        if (editableTags.includes(tag)) {
          el.setAttribute("contenteditable", "true");
          el.focus();
        }
      });

      // Dragover handler
      iframeDoc.body.addEventListener("dragover", e => {
        e.preventDefault();
      });

      iframeDoc.body.addEventListener("drop", e => {
        e.preventDefault();
        if (e.dataTransfer.getData("text/plain") !== "__eva_selected") return;

        const target = e.target;
        const draggedEl = selectedElement;

        if (!draggedEl || draggedEl.contains(target) || draggedEl === target) return;

        target.insertAdjacentElement("afterend", draggedEl);
        highlightSelectedElement(draggedEl);
      });

      if (!iframeDoc.querySelector("style[data-drop-highlight]")) {
        const style = iframeDoc.createElement("style");
        style.setAttribute("data-drop-highlight", "true");
        style.textContent = `
          [data-eva-drop-highlight] {
            outline: 1.6px dashed #2db6f5;
            outline-offset: -2px;
          }
        `;

        iframeDoc.head.appendChild(style);
      }
    }

    function highlightSelectedElement(el) {
      // => Readonly Element
      // if (isReadOnlyElement(el)) {
      //   const editableSelector = (options.codeEditor?.editable || []).join(",");
      //   if (editableSelector) {
      //     const editableParent = el.closest(editableSelector);
      //     if (editableParent) {
      //       el = editableParent; // Move selection target to editable parent
      //     }
      //   }

      //   stopPopoverTracking(); // Keep popovers turned off for this element
      //   return;
      // }

      if (isReadOnlyElement(el)) {
        const editableSelector = (options.codeEditor?.editable || []).join(",");
        let fallback = null;

        if (editableSelector) {
          const editableParent = el.closest(editableSelector);
          if (editableParent) {
            fallback = editableParent;
          }
        }

        // if there is no editable parent → use the default Selected Element
        if (!fallback && options.defaultSelectedElement) {
          fallback = iframeDoc.querySelector(options.defaultSelectedElement);
        }

        if (fallback) {
          highlightSelectedElement(fallback);
        } else {
          stopPopoverTracking(); 
        }

        return;
      }
      // => End of Readonly Element

      if (!el || !iframeDoc) return;

      const liParent = el.closest("li");

      if (el.tagName === "A" && el.querySelector("img")) {
        highlightTarget = el.querySelector("img");
      } else if (el.closest(".resize-wrapper")) {
        highlightTarget = el.closest(".resize-wrapper").querySelector("img");
      } else {
        highlightTarget = liParent || el;
      }

      previousSelectedElement = selectedElement;
      selectedElement = highlightTarget;

      if (previousSelectedElement) {
        const wrapperEl = previousSelectedElement.closest(".resize-wrapper");
        const imgEl = wrapperEl ? wrapperEl.querySelector("img") : null;
        const isStillSelectingImg =
          highlightTarget === imgEl ||
          highlightTarget === wrapperEl ||
          (wrapperEl && wrapperEl.contains(highlightTarget));

        if (
          wrapperEl &&
          wrapperEl.classList.contains("resize-wrapper") &&
          imgEl &&
          !isStillSelectingImg
        ) {
          const original = originalImagePositionMap.get(imgEl);
          if (original && original.parent) {
            const styleBackup = imgEl.getAttribute("style");

            wrapperEl.removeChild(imgEl);
            const refNode = original.parent.children[original.index] || null;
            original.parent.insertBefore(imgEl, refNode);
            imgEl.setAttribute("style", styleBackup || "");
            wrapperEl.remove();
          }
        }
      }

      // If the selected element is an image, add a resize point.
      if (highlightTarget.tagName === "IMG") {
        if (!highlightTarget.parentElement.classList.contains("resize-wrapper")) {
          const parent = highlightTarget.parentElement;
          const index = Array.from(parent.children).indexOf(highlightTarget);
          originalImagePositionMap.set(highlightTarget, { parent, index });
        }

        addResizeHandles(highlightTarget);
      }

      // Inject highlight style if not present
      if (!iframeDoc.querySelector("style[data-highlight]")) {
        const style = iframeDoc.createElement("style");
        style.setAttribute("data-highlight", "true");
        style.textContent = `
          [data-eva-highlight] {
            outline: 2px solid #696cff;
            outline-offset: 2px;
          }
        `;
        iframeDoc.head.appendChild(style);
      }

      iframeDoc.querySelectorAll("[data-eva-highlight]").forEach((node) => {
        node.removeAttribute("data-eva-highlight");
        node.removeAttribute("draggable");
      });

      highlightTarget.setAttribute("data-eva-highlight", "true");
      highlightTarget.setAttribute("draggable", "true");

      // --- Dragstart handling ---
      if (highlightTarget._evaDragStartHandler) {
        highlightTarget.removeEventListener("dragstart", highlightTarget._evaDragStartHandler);
      }

      highlightTarget._evaDragStartHandler = function (e) {
        // Element validation
        if (!highlightTarget || !(highlightTarget instanceof HTMLElement)) {
          draggedElement = null;
          return;
        }

        // If in an <li>, drag the <li>, otherwise drag the element itself.
        const liParent = highlightTarget.closest("li");
        draggedElement = liParent || highlightTarget;
        e.dataTransfer.setData("text/plain", "__eva_selected");
      };

      highlightTarget.addEventListener("dragstart", highlightTarget._evaDragStartHandler);

      // Remove contenteditable from other elements
      iframeDoc.querySelectorAll("[contenteditable]").forEach((node) => {
        if (node !== highlightTarget) node.removeAttribute("contenteditable");
      });

      updateStyleManagerPanel();

      if (isReadOnlyElement(el)) {
        stopPopoverTracking();
      } else {
        if (el.tagName === "I") {
          publicAPI.setPopoverContent?.("icon");
        } else if (el.tagName === "A" && iframeDoc.body.contains(el)) {
          publicAPI.setPopoverContent?.("link");
        } else {
          publicAPI.setPopoverContent?.("default");
        }

        startPopoverTracking();
      }
    }

    // --- Resize IMG ---
    function addResizeHandles(imgEl) {
      const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;

      imgEl.style.width = `${imgEl.offsetWidth}px`;
      imgEl.style.height = `${imgEl.offsetHeight}px`;
      imgEl.style.display = "block";
      imgEl.style.maxWidth = "none";
      imgEl.style.maxHeight = "none";
      imgEl.style.boxSizing = "border-box";

      // Create a wrapper if it doesn't exist yet
      let wrapper = imgEl.parentElement;
      if (!wrapper.classList.contains("resize-wrapper")) {
        wrapper = iframeDoc.createElement("div");
        wrapper.className = "resize-wrapper";

        wrapper.style.position = "relative";
        wrapper.style.display = "inline-block";
        wrapper.style.boxSizing = "border-box";
        wrapper.style.padding = "0";
        wrapper.style.margin = "0";
        wrapper.style.border = "none";
        wrapper.style.overflow = "visible";

        imgEl.replaceWith(wrapper);
        wrapper.appendChild(imgEl);
      }

      // Adjust the wrapper size
      wrapper.style.width = `${imgEl.offsetWidth}px`;
      wrapper.style.height = `${imgEl.offsetHeight}px`;

      const positions = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

      positions.forEach(pos => {
        const handle = iframeDoc.createElement("div");
        handle.className = `resize-handle ${pos}`;
        handle.dataset.position = pos;

        // Visual style
        handle.style.position = "absolute";
        handle.style.width = "8px";
        handle.style.height = "8px";
        handle.style.background = "#fff";
        handle.style.border = "1px solid #666";
        handle.style.borderRadius = "50%";
        handle.style.zIndex = "9999";
        handle.style.cursor = getCursorForPosition(pos);
        handle.style.userSelect = "none";
        handle.style.pointerEvents = "auto";

        // Flexible handle position
        if (pos === 'top-left') {
          handle.style.top = "0";
          handle.style.left = "0";
          handle.style.transform = "translate(-50%, -50%)";
        } else if (pos === 'top-right') {
          handle.style.top = "0";
          handle.style.left = "100%";
          handle.style.transform = "translate(-50%, -50%)";
        } else if (pos === 'bottom-left') {
          handle.style.top = "100%";
          handle.style.left = "0";
          handle.style.transform = "translate(-50%, -50%)";
        } else if (pos === 'bottom-right') {
          handle.style.top = "100%";
          handle.style.left = "100%";
          handle.style.transform = "translate(-50%, -50%)";
        }

        wrapper.appendChild(handle);

        // Drag resize logic
        handle.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();

          const startX = e.clientX;
          const startY = e.clientY;
          const startWidth = imgEl.offsetWidth;
          const startHeight = imgEl.offsetHeight;
          const aspectRatio = startWidth / startHeight;

          function onMouseMove(moveEvent) {
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;

            let newWidth = startWidth;
            let newHeight = startHeight;

            if (moveEvent.ctrlKey) {
              // Ctrl+Drag: Resize proportionally (keep ratio)
              if (pos.includes("right") || pos.includes("left")) {
                newWidth = Math.max(20, startWidth + dx * (pos.includes("left") ? -1 : 1));
                newHeight = Math.max(20, newWidth / aspectRatio);
              } else if (pos.includes("top") || pos.includes("bottom")) {
                newHeight = Math.max(20, startHeight + dy * (pos.includes("top") ? -1 : 1));
                newWidth = Math.max(20, newHeight * aspectRatio);
              }
            } else if (moveEvent.shiftKey) {
              // Shift+Drag: Free (without maintaining ratio)
              if (pos.includes("right") || pos.includes("left")) {
                newWidth = Math.max(20, startWidth + dx * (pos.includes("left") ? -1 : 1));
              }

              if (pos.includes("bottom") || pos.includes("top")) {
                newHeight = Math.max(20, startHeight + dy * (pos.includes("top") ? -1 : 1));
              }
            } else {
              if (pos.includes("right")) {
                newWidth = Math.max(20, startWidth + dx);
              }

              if (pos.includes("bottom")) {
                newHeight = Math.max(20, startHeight + dy);
              }
            }

            imgEl.style.width = `${newWidth}px`;
            imgEl.style.height = `${newHeight}px`;

            wrapper.style.width = `${newWidth}px`;
            wrapper.style.height = `${newHeight}px`;
          }

          function onMouseUp() {
            iframeDoc.removeEventListener("mousemove", onMouseMove);
            iframeDoc.removeEventListener("mouseup", onMouseUp);

            if (typeof saveState === "function") {
              saveState();
            }
          }

          iframeDoc.addEventListener("mousemove", onMouseMove);
          iframeDoc.addEventListener("mouseup", onMouseUp);
        });
      });

      // Cursor for each handle
      function getCursorForPosition(pos) {
        switch (pos) {
          case 'top-left':
          case 'bottom-right':
            return 'nwse-resize';
          case 'top-right':
          case 'bottom-left':
            return 'nesw-resize';
          default:
            return 'pointer';
        }
      }
    }

    function removeResizeWrapper(el) {
      // If what is removed is a wrapper, look for <img> in it
      if (el.classList.contains("resize-wrapper")) {
        const img = el.querySelector("img");
        if (img) el.removeChild(img);
        el.remove();
      }

      // If what is deleted is <img> inside the wrapper
      else if (el.tagName === "IMG" && el.parentElement.classList.contains("resize-wrapper")) {
        const wrapper = el.parentElement;
        wrapper.removeChild(el);
        wrapper.remove();
      }

      // If <img> without wrapper
      else if (el.tagName === "IMG") {
        el.remove();
      }
    }

    // --- Drag & Drop Internal Elements ---
    function enableInternalDragDrop() {
      // Remove native browser draggable
      iframeDoc.querySelectorAll("[draggable]").forEach(el => {
        el.removeAttribute("draggable");
      });

      let isDragging = false;
      let ghostNode = null;
      let startX = 0;
      let startY = 0;
      let currentDropTarget = null;

      iframeDoc.body.setAttribute('tabindex', '-1');
      iframeDoc.body.addEventListener("mousedown", (e) => {
        if (isReadOnlyElement(draggedElement)) {
          draggedElement = null;
          return;
        }

        saveState();
        const parentLI = e.target.closest("li");
        draggedElement = parentLI || e.target;

        if (!draggedElement || draggedElement !== selectedElement) {
          isDragging = false;
          return;
        }

        // Create ghostNode
        ghostNode = draggedElement.cloneNode(true);
        ghostNode.classList.add("eva-ghost");
        ghostNode.style.position = "absolute";
        ghostNode.style.opacity = "0.5";
        ghostNode.style.pointerEvents = "none";
        ghostNode.style.zIndex = "9999";
        ghostNode.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.2)";
        ghostNode.style.border = "1px dashed #696cff";
        ghostNode.style.borderRadius = "6px";
        ghostNode.style.background = "#ffffff";
        ghostNode.style.padding = "6px";
        ghostNode.style.transform = "scale(1.02)";
        ghostNode.style.transition = "transform 0.1s ease";

        if (draggedElement.querySelector("img")) {
          const imgInside = draggedElement.querySelector("img").cloneNode(true);
          imgInside.style.maxHeight = "40px";
          imgInside.style.objectFit = "contain";

          ghostNode.innerHTML = "";
          ghostNode.appendChild(imgInside);
          ghostNode.style.width = "auto";
          ghostNode.style.height = "auto";
        } else {
          const previewText = draggedElement.textContent?.trim().slice(0, 30) || "Dragging...";
          ghostNode.textContent = previewText;
          ghostNode.style.fontSize = "12px";
          ghostNode.style.color = "#333";
          ghostNode.style.maxWidth = "200px";
          ghostNode.style.overflow = "hidden";
          ghostNode.style.textOverflow = "ellipsis";
          ghostNode.style.whiteSpace = "nowrap";
        }

        iframeDoc.body.appendChild(ghostNode);

        ghostNode.animate([
          { opacity: 0, transform: "scale(0.9)" },
          { opacity: 0.5, transform: "scale(1.02)" }
        ], {
          duration: 120,
          easing: "ease-out",
          fill: "forwards"
        });

        startX = e.clientX;
        startY = e.clientY;
        ghostNode.style.left = `${startX}px`;
        ghostNode.style.top = `${startY}px`;

        isDragging = true;
        e.preventDefault();
        iframeDoc.body.focus();
      });

      iframeDoc.body.addEventListener("mousemove", (e) => {
        if (!isDragging || !ghostNode) return;
        e.preventDefault();

        ghostNode.style.left = `${e.clientX}px`;
        ghostNode.style.top = `${e.clientY}px`;

        const target = e.target.closest("*");
        if (target && target !== draggedElement && !draggedElement.contains(target)) {
          if (currentDropTarget && currentDropTarget !== target) {
            currentDropTarget.style.outline = "";
          }
          currentDropTarget = target;
          currentDropTarget.style.outline = "1.6px dashed #2db6f5";
        } else if (currentDropTarget) {
          currentDropTarget.style.outline = "";
          currentDropTarget = null;
        }
      });

      iframeDoc.body.addEventListener("mouseup", (e) => {
        if (!draggedElement || isReadOnlyElement(draggedElement)) {
          cleanupDrag();
          return;
        }

        if (ghostNode) ghostNode.remove();
        ghostNode = null;
        isDragging = false;

        const dropTarget = e.target;
        if (!dropTarget || dropTarget === draggedElement || draggedElement.contains(dropTarget)) {
          cleanupDrag();
          return;
        }

        if (draggedElement.tagName === "LI") {
          const parentUL = dropTarget.closest("ul, ol");
          const targetLI = dropTarget.closest("li");

          if (parentUL && targetLI) {
            const rect = targetLI.getBoundingClientRect();
            const middleY = rect.top + rect.height / 2;

            if (e.clientY < middleY) {
              parentUL.insertBefore(draggedElement, targetLI);
            } else {
              parentUL.insertBefore(draggedElement, targetLI.nextSibling);
            }

            saveState();
          }
        } else {
          dropTarget.insertAdjacentElement("afterend", draggedElement);
          saveState();
        }

        highlightSelectedElement(draggedElement);
        draggedElement.scrollIntoView({ behavior: "smooth", block: "center" });
        cleanupDrag();
      });

      iframeDoc.addEventListener("keydown", (e) => {
        if (isDragging && e.key === "Escape") {
          cleanupGhost();
          if (currentDropTarget) {
            currentDropTarget.style.outline = "";
            currentDropTarget = null;
          }

          isDragging = false;
        }
      });

      function cleanupDrag() {
        cleanupGhost();
        if (currentDropTarget) {
          currentDropTarget.style.outline = "";
          currentDropTarget = null;
        }

        isDragging = false;
      }

      function cleanupGhost() {
        if (ghostNode) ghostNode.remove();
        ghostNode = null;
      }
    }

    // --- Drag & Drop Blocks ---
    function renderBlockContent(content) {
      if (typeof content === "string") return content;

      const {
        type = "div",
        class: cls = "",
        href = null,
        src = null,
        body = "",
        attributes = {}
      } = content;

      const el = document.createElement(type);

      if (cls) el.className = cls;
      if (href) el.setAttribute("href", href);

      if (type === "img" && !src) {
        el.setAttribute("src", `${url}/assets/eva/js/module/eva/editor/no-image.jpg`);
        el.setAttribute("style", "width: 120px");
      } else if (src) {
        e.setAttribute("src", src);
      }

      for (const [key, val] of Object.entries(attributes)) {
        el.setAttribute(key, val);
      }

      el.innerHTML = body;

      // If it's a <ul>, make it editable and selectable
      if (el.tagName === "UL") {
        el.setAttribute("contenteditable", "true"); // Allow editing
        el.addEventListener("click", () => {
          highlightSelectedElement(el); // Allow <ul> to be selected when clicked
        });
      }

      return el.outerHTML;
    }

    function addBlocks(...blockItems) {
      const panel = container.querySelector(".eva-builder-sidebar .eva-builder-panel");
      if (!panel) return console.warn("Sidebar panel not found: .eva-builder-sidebar");

      const grouped = {};
      const accordionId = `${options.container.replace('#', '')}-blocks-accordion`;

      blockItems.forEach((block) => {
        const cat = block.category || "Uncategorized";
        if (!grouped[cat]) grouped[cat] = [];

        const blockIndex = blocks.length;
        blocks.push(block);
        grouped[cat].push({ ...block, __index: blockIndex });
      });

      // Find or create the accordion container in sidebar
      let accordionContainer = panel.querySelector(`#${accordionId}`);
      if (!accordionContainer) {
        accordionContainer = document.createElement("div");
        accordionContainer.classList.add("accordion");
        accordionContainer.id = accordionId;
        panel.appendChild(accordionContainer);
      }

      // For each category, create accordion item
      Object.entries(grouped).forEach(([category, items], idx) => {
        const accordionItem = document.createElement("div");
        accordionItem.className = "accordion-item";

        const collapseId = `${accordionId}-collapse-${category}-${idx}`;
        // Accordion header structure
        accordionItem.innerHTML = `
          <h2 class="accordion-header" id="heading-${category}-${idx}">
            <button class="accordion-button collapsed small" type="button" data-bs-toggle="collapse" data-bs-target="#${collapseId}" aria-expanded="false" aria-controls="${collapseId}">
              ${category}
            </button>
          </h2>
          <div id="${collapseId}" class="accordion-collapse collapse" aria-labelledby="heading-${category}-${idx}" data-bs-parent="#eva-blocks-accordion">
            <div class="accordion-body list-group list-group-flushing">
              ${items.map(block => `
                <div class="eva-block-item list-group-item border-none d-flex align-items-center ps-0 small" draggable="true" data-block-index="${block.__index}">
                  <div class="d-flex align-items-center">
                    <div class="eva-block-preview">${block.iconClass ? `<i class="${block.iconClass}"></i>` : ""}</div>
                    <div class="eva-block-label">${block.label || "Block"}</div>
                  </div>
                </div>
              `).join("")}
            </div>
          </div>
        `;

        // Add the accordion item to the panel
        accordionContainer.appendChild(accordionItem);

        // Add dragstart event to each block item
        const blockItems = accordionItem.querySelectorAll(".eva-block-item");
        blockItems.forEach(item => {
          item.addEventListener("dragstart", (e) => {
            // Set the dragged block index in dataTransfer
            e.dataTransfer.setData("eva/block-index", item.dataset.blockIndex);
            saveState();
          });
        });
      });
    }

    // --- Selected Element Style ---
    function showStyleEditorPanel() {
      if (!selectedElement) {
        console.warn("No element selected for style editing.");
        return;
      }

      // Remove old panel if exists
      const existingPanel = document.querySelector("#styleEditorPanel");
      if (existingPanel) existingPanel.remove();

      const panel = document.createElement("div");
      panel.id = "styleEditorPanel";
      panel.className = "card card-action border-1 position-fixed";
      panel.style.top = "80px";
      panel.style.right = "20px";
      panel.style.width = "380px";
      panel.style.zIndex = "1100";
      panel.innerHTML = `
        <div class="card-header border-bottom py-3">
          <h6 class="card-action-title mb-0">Style Manager</h6>
          <div class="card-action-element">
            <button type="button" class="btn btn-xs rounded-pill btn-icon btn-label-danger card-close">
              <i class="icon-base bx bx-x"></i>
            </button>
          </div>
        </div>
        <div class="card-body py-6" style="overflow: auto; max-height: 400px;">
          <div id="accordionStyle" class="accordion">
            <div class="accordion-item shadow-none no-border-radius">
              <div id="dimensionHeader" class="accordion-header">
                <button type="button" class="accordion-button px-0 small collapsed" data-bs-toggle="collapse" data-bs-target="#dimensionStyle" aria-expanded="false" aria-controls="dimensionStyle">Dimension</button>
              </div>
              <div id="dimensionStyle" class="accordion-collapse collapse" aria-labelledby="dimensionHeader">
                <div class="accordion-body px-0 pt-2 list-group list-group-flushing no-border-radius">
                  <div class="row mb-4">
                    <div class="col-6 mb-4">
                      <label class="form-label">Width</label>
                      <div class="input-group input-group-sm">
                        <input type="number" id="widthStyle" class="form-control form-control-sm" placeholder="auto">
                        <select class="form-select form-select-sm" id="widthStyleSet">
                          <option value="px" selected>px</option>
                          <option value="%">%</option>
                          <option value="em">em</option>
                          <option value="rem">rem</option>
                        </select>
                      </div>
                    </div>
                    <div class="col-6 mb-4">
                      <label class="form-label">Height</label>
                      <div class="input-group input-group-sm">
                        <input type="number" id="heightStyle" class="form-control form-control-sm" placeholder="auto">
                        <select class="form-select form-select-sm" id="heightStyleSet">
                          <option value="px" selected>px</option>
                          <option value="%">%</option>
                          <option value="em">em</option>
                          <option value="rem">rem</option>
                        </select>
                      </div>
                    </div>
                    <div class="col-6">
                      <label class="form-label">Max Width</label>
                      <div class="input-group input-group-sm">
                        <input type="number" id="maxWidthStyle" class="form-control form-control-sm" placeholder="auto">
                        <select class="form-select form-select-sm" id="maxWidthSet">
                          <option value="px" selected>px</option>
                          <option value="%">%</option>
                          <option value="em">em</option>
                          <option value="rem">rem</option>
                        </select>
                      </div>
                    </div>
                    <div class="col-6">
                      <label class="form-label">Max Height</label>
                      <div class="input-group input-group-sm">
                        <input type="number" id="maxHeightStyle" class="form-control form-control-sm" placeholder="auto">
                        <select class="form-select form-select-sm" id="maxHeightSet">
                          <option value="px" selected>px</option>
                          <option value="%">%</option>
                          <option value="em">em</option>
                          <option value="rem">rem</option>
                        </select>
                      </div>
                    </div>
                  </div>
                  <div class="mb-4">
                    <label class="form-label">Margin</label>
                    <div class="card shadow-none border-1">
                      <div class="card-body p-3">
                        <div class="row">
                          <div class="col-6 mb-4">
                            <label class="form-label">Top</label>
                            <div class="input-group input-group-sm">
                              <input type="number" class="form-control form-control-sm" id="marginTop" placeholder="0">
                              <select class="form-select form-select-sm" id="marginTopSet">
                                <option value="px" selected>px</option>
                                <option value="%">%</option>
                                <option value="em">em</option>
                                <option value="rem">rem</option>
                              </select>
                            </div>
                          </div>
                          <div class="col-6 mb-4">
                            <label class="form-label">Bottom</label>
                            <div class="input-group input-group-sm">
                              <input type="number" class="form-control form-control-sm" id="marginBottom" placeholder="0">
                              <select class="form-select form-select-sm" id="marginBottomSet">
                                <option value="px" selected>px</option>
                                <option value="%">%</option>
                                <option value="em">em</option>
                                <option value="rem">rem</option>
                              </select>
                            </div>
                          </div>
                          <div class="col-6">
                            <label class="form-label">Right</label>
                            <div class="input-group input-group-sm">
                              <input type="number" class="form-control form-control-sm" id="marginRight" placeholder="0">
                              <select class="form-select form-select-sm" id="marginRightSet">
                                <option value="px" selected>px</option>
                                <option value="%">%</option>
                                <option value="em">em</option>
                                <option value="rem">rem</option>
                              </select>
                            </div>
                          </div>
                          <div class="col-6">
                            <label class="form-label">Left</label>
                            <div class="input-group input-group-sm">
                              <input type="number" class="form-control form-control-sm" id="marginLeft" placeholder="0">
                              <select class="form-select form-select-sm" id="marginLeftSet">
                                <option value="px" selected>px</option>
                                <option value="%">%</option>
                                <option value="em">em</option>
                                <option value="rem">rem</option>
                              </select>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="mb-4">
                    <label class="form-label">Padding</label>
                    <div class="card shadow-none border-1">
                      <div class="card-body p-3">
                        <div class="row">
                          <div class="col-6 mb-4">
                            <label class="form-label">Top</label>
                            <div class="input-group input-group-sm">
                              <input type="number" class="form-control form-control-sm" id="paddingTop" placeholder="0">
                              <select class="form-select form-select-sm" id="paddingTopSet">
                                <option value="px" selected>px</option>
                                <option value="%">%</option>
                                <option value="em">em</option>
                                <option value="rem">rem</option>
                              </select>
                            </div>
                          </div>
                          <div class="col-6 mb-4">
                            <label class="form-label">Bottom</label>
                            <div class="input-group input-group-sm">
                              <input type="number" class="form-control form-control-sm" id="paddingBottom" placeholder="0">
                              <select class="form-select form-select-sm" id="paddingBottomSet">
                                <option value="px" selected>px</option>
                                <option value="%">%</option>
                                <option value="em">em</option>
                                <option value="rem">rem</option>
                              </select>
                            </div>
                          </div>
                          <div class="col-6">
                            <label class="form-label">Right</label>
                            <div class="input-group input-group-sm">
                              <input type="number" class="form-control form-control-sm" id="paddingRight" placeholder="0">
                              <select class="form-select form-select-sm" id="paddingRightSet">
                                <option value="px" selected>px</option>
                                <option value="%">%</option>
                                <option value="em">em</option>
                                <option value="rem">rem</option>
                              </select>
                            </div>
                          </div>
                          <div class="col-6">
                            <label class="form-label">Left</label>
                            <div class="input-group input-group-sm">
                              <input type="number" class="form-control form-control-sm" id="paddingLeft" placeholder="0">
                              <select class="form-select form-select-sm" id="paddingLeftSet">
                                <option value="px" selected>px</option>
                                <option value="%">%</option>
                                <option value="em">em</option>
                                <option value="rem">rem</option>
                              </select>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div class="accordion-item shadow-none no-border-radius">
              <div id="typographyHeader" class="accordion-header">
                <button type="button" class="accordion-button px-0 small collapsed" data-bs-toggle="collapse" data-bs-target="#typographyStyle" aria-expanded="false" aria-controls="typographyStyle">Typography</button>
              </div>
              <div id="typographyStyle" class="accordion-collapse collapse" aria-labelledby="typographyHeader">
                <div class="accordion-body px-0 pt-2 list-group list-group-flushing no-border-radius">
                  <div class="row mb-4">
                    <div class="col-6 mb-4">
                      <label class="form-label mb-0">Font</label>
                      <select class="form-select form-select-sm" id="fontFamily">
                        <option value="" selected>...</option>
                        <option value="Arial">Arial</option>
                        <option value="Arial Black">Arial Black</option>
                        <option value="Brush Script MT">Brush Script MT</option>
                        <option value="Comic Sans MS">Comic Sans MS</option>
                        <option value="Courier New">Courier New</option>
                        <option value="Georgia">Georgia</option>
                        <option value="Helvetica">Helvetica</option>
                        <option value="Impact">Impact</option>
                        <option value="Lucida Sans Unicode">Lucida Sans Unicode</option>
                        <option value="Tahoma">Tahoma</option>
                        <option value="Times New Roman">Times New Roman</option>
                        <option value="Trebuchet MS">Trebuchet MS</option>
                        <option value="Verdana">Verdana</option>
                      </select>
                    </div>
                    <div class="col-6 mb-4">
                      <label class="form-label mb-0">Size</label>
                      <div class="input-group input-group-sm">
                        <input type="number" id="fontSize" class="form-control form-control-sm" placeholder="auto">
                        <select class="form-select form-select-sm" id="fontSizeSet">
                          <option value="px" selected>px</option>
                          <option value="%">%</option>
                          <option value="em">em</option>
                          <option value="rem">rem</option>
                        </select>
                      </div>
                    </div>
                    <div class="col-6">
                      <label class="form-label mb-0">Weight</label>
                      <select id="fontWeight" class="form-select form-select-sm">
                        <option value="">...</option>
                        <option value="100">Thin</option>
                        <option value="200">Extra-Light</option>
                        <option value="300">Light</option>
                        <option value="400">Normal</option>
                        <option value="500">Medium</option>
                        <option value="600">Semi-Bold</option>
                        <option value="700">Bold</option>
                        <option value="800">Extra-Bold</option>
                        <option value="900">Ultra-Bold</option>
                      </select>
                    </div>
                    <div class="col-6">
                      <label class="form-label mb-0">Spacing</label>
                      <div class="input-group input-group-sm">
                        <input type="number" id="letterSpacing" class="form-control form-control-sm" placeholder="auto">
                        <select class="form-select form-select-sm" id="letterSpacingSet">
                          <option value="px" selected>px</option>
                          <option value="%">%</option>
                          <option value="em">em</option>
                          <option value="rem">rem</option>
                        </select>
                      </div>
                    </div>
                  </div>
                  <div class="row d-flex justify-content-between align-items-center mb-4">
                    <label class="form-label col-5 mb-0">Text Color</label>
                    <div class="col-7">
                      <div class="input-group input-group-sm">
                        <input type="color" class="form-control form-control-sm" id="colorPicker">
                      </div>
                    </div>
                  </div>
                  <div class="row d-flex justify-content-between align-items-center mb-4">
                    <label class="form-label col-5 mb-0">Line Height</label>
                    <div class="col-7">
                      <div class="input-group input-group-sm">
                        <input type="number" class="form-control form-control-sm" id="lineHeight" placeholder="normal">
                        <select class="form-select form-select-sm" id="lineHeightSet">
                          <option value="px" selected>px</option>
                          <option value="%">%</option>
                          <option value="em">em</option>
                          <option value="rem">rem</option>
                        </select>
                      </div>
                    </div>
                  </div>
                  <div class="row mb-4">
                    <div class="col-12 mb-4">
                      <label class="form-label">Text Align</label>
                      <div class="d-flex justify-content-center">
                        <div class="btn-group btn-group-xs" role="group" aria-label="Text Align group">
                          <button type="button" class="btn btn-outline-dark" id="align-left">
                            <i class="icon-base bx bx-align-left fs-5"></i>
                          </button>
                          <button type="button" class="btn btn-outline-dark" id="align-center">
                            <i class="icon-base bx bx-align-center fs-5"></i>
                          </button>
                          <button type="button" class="btn btn-outline-dark" id="align-right">
                            <i class="icon-base bx bx-align-right fs-5"></i>
                          </button>
                          <button type="button" class="btn btn-outline-dark" id="align-justify">
                            <i class="icon-base bx bx-align-justify fs-5"></i>
                          </button>
                        </div>
                      </div>
                    </div>
                    <div class="col-12 mb-4">
                      <label class="form-label">Font Style</label>
                      <div class="d-flex justify-content-center">
                        <div class="btn-group btn-group-xs" role="group" aria-label="Font Style group">
                          <button type="button" class="btn btn-outline-dark" id="style-bold">
                            <i class="icon-base bx bx-bold fs-5"></i>
                          </button>
                          <button type="button" class="btn btn-outline-dark" id="style-italic">
                            <i class="icon-base bx bx-italic fs-5"></i>
                          </button>
                          <button type="button" class="btn btn-outline-dark" id="style-underline">
                            <i class="icon-base bx bx-underline fs-5"></i>
                          </button>
                          <button type="button" class="btn btn-outline-dark" id="style-strikethrough">
                            <i class="icon-base bx bx-strikethrough fs-5"></i>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div class="accordion-item shadow-none no-border-radius">
              <div id="decorationHeader" class="accordion-header">
                <button type="button" class="accordion-button px-0 small collapsed" data-bs-toggle="collapse" data-bs-target="#decorationStyle" aria-expanded="false" aria-controls="decorationStyle">Decoration</button>
              </div>
              <div id="decorationStyle" class="accordion-collapse collapse" aria-labelledby="decorationHeader">
                <div class="accordion-body px-0 pt-2 list-group list-group-flushing no-border-radius">
                  <div class="row d-flex justify-content-between align-items-center mb-4">
                    <label class="form-label col-6 mb-0">Background Color</label>
                    <div class="col-6">
                      <div class="input-group input-group-sm">
                        <input type="color" class="form-control form-control-sm" id="backgroundColor">
                      </div>
                    </div>
                  </div>
                  <div class="mb-4">
                    <label class="form-label">Border Radius</label>
                    <div class="card shadow-none border-1">
                      <div class="card-body p-3">
                        <div class="row">
                          <div class="col-6 mb-4">
                            <label class="form-label">Top Left</label>
                            <div class="input-group input-group-sm">
                              <input type="number" class="form-control form-control-sm" id="borderTopLeftRadius" placeholder="0">
                              <select class="form-select form-select-sm" id="borderTopLeftSet">
                                <option value="px" selected>px</option>
                                <option value="%">%</option>
                                <option value="em">em</option>
                                <option value="rem">rem</option>
                              </select>
                            </div>
                          </div>
                          <div class="col-6 mb-4">
                            <label class="form-label">Top Right</label>
                            <div class="input-group input-group-sm">
                              <input type="number" class="form-control form-control-sm" id="borderTopRightRadius" placeholder="0">
                              <select class="form-select form-select-sm" id="borderTopRightSet">
                                <option value="px" selected>px</option>
                                <option value="%">%</option>
                                <option value="em">em</option>
                                <option value="rem">rem</option>
                              </select>
                            </div>
                          </div>
                          <div class="col-6">
                            <label class="form-label">Bottom Left</label>
                            <div class="input-group input-group-sm">
                              <input type="number" class="form-control form-control-sm" id="borderBottomLeftRadius" placeholder="0">
                              <select class="form-select form-select-sm" id="borderBottomLeftSet">
                                <option value="px" selected>px</option>
                                <option value="%">%</option>
                                <option value="em">em</option>
                                <option value="rem">rem</option>
                              </select>
                            </div>
                          </div>
                          <div class="col-6">
                            <label class="form-label">Bottom Right</label>
                            <div class="input-group input-group-sm">
                              <input type="number" class="form-control form-control-sm" id="borderBottomRightRadius" placeholder="0">
                              <select class="form-select form-select-sm" id="borderBottomRightSet">
                                <option value="px" selected>px</option>
                                <option value="%">%</option>
                                <option value="em">em</option>
                                <option value="rem">rem</option>
                              </select>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="mb-4">
                    <label class="form-label">Border</label>
                    <div class="card shadow-none border-1">
                      <div class="card-body p-3">
                        <div class="row">
                          <div class="col-6 mb-4">
                            <label class="form-label">Width</label>
                            <div class="input-group input-group-sm">
                              <input type="number" class="form-control form-control-sm" id="borderWidth" placeholder="0">
                              <select class="form-select form-select-sm" id="borderWidthSet">
                                <option value="px" selected>px</option>
                                <option value="%">%</option>
                                <option value="em">em</option>
                                <option value="rem">rem</option>
                              </select>
                            </div>
                          </div>
                          <div class="col-6 mb-4">
                            <label class="form-label">Style</label>
                            <select id="borderStyle" class="form-select form-select-sm">
                              <option value="" selected>...</option>
                              <option value="none">None</option>
                              <option value="solid">Solid</option>
                              <option value="dotted">Dotted</option>
                              <option value="dashed">Dashed</option>
                              <option value="double">Double</option>
                              <option value="groove">Groove</option>
                              <option value="ridge">Ridge</option>
                              <option value="inset">Inset</option>
                              <option value="outset">Outset</option>
                            </select>
                          </div>
                          <div class="col-12">
                            <div class="row d-flex justify-content-between align-items-center mb-4">
                              <label class="form-label col-6 mb-0">Border Color</label>
                              <div class="col-6">
                                <div class="input-group input-group-sm">
                                  <input type="color" class="form-control form-control-sm" id="borderColor" placeholder="none">
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      container.appendChild(panel);
      // Close button
      panel.querySelector(".card-close").addEventListener("click", () => {
        if (panel) {
          panel.remove();
          const styleBtn = container.querySelector('[eva-builder="style"]');
          if (styleBtn) styleBtn.classList.remove("active");
        }
      });

      setInitialStyles(selectedElement); // Set initial values
      bindLiveStyleEvents(selectedElement); // Bind events
      styleManagerMakeDraggable(panel, ".card-header");
    }

    function updateStyleManagerPanel() {
      const panel = document.getElementById('styleEditorPanel');
      if (panel) {
        setInitialStyles(selectedElement);
        bindLiveStyleEvents(selectedElement);
      }
    }

    function setInitialStyles(el) {
      // Dimension
      document.getElementById('widthStyle').value = parseInt(el.style.width) || '';
      document.getElementById('heightStyle').value = parseInt(el.style.height) || '';
      document.getElementById('maxWidthStyle').value = parseInt(el.style.maxWidth) || '';
      document.getElementById('maxHeightStyle').value = parseInt(el.style.maxHeight) || '';
      // Margin
      document.getElementById('marginTop').value = parseInt(el.style.marginTop) || '';
      document.getElementById('marginBottom').value = parseInt(el.style.marginBottom) || '';
      document.getElementById('marginLeft').value = parseInt(el.style.marginLeft) || '';
      document.getElementById('marginRight').value = parseInt(el.style.marginRight) || '';
      // Padding
      document.getElementById('paddingTop').value = parseInt(el.style.paddingTop) || '';
      document.getElementById('paddingBottom').value = parseInt(el.style.paddingBottom) || '';
      document.getElementById('paddingLeft').value = parseInt(el.style.paddingLeft) || '';
      document.getElementById('paddingRight').value = parseInt(el.style.paddingRight) || '';
      // Typography
      document.getElementById('fontSize').value = parseInt(el.style.fontSize) || '';
      document.getElementById('fontWeight').value = el.style.fontWeight || '';
      document.getElementById('lineHeight').value = parseInt(el.style.lineHeight) || '';
      document.getElementById('letterSpacing').value = parseInt(el.style.letterSpacing) || '';
      document.getElementById('colorPicker').value = rgbToHex(el.style.color || '#000000');
      document.getElementById('backgroundColor').value = rgbToHex(el.style.backgroundColor || '#000000');
      // Border
      document.getElementById('borderWidth').value = parseInt(el.style.borderWidth) || '';
      document.getElementById('borderStyle').value = el.style.borderStyle || '';
      document.getElementById('borderColor').value = rgbToHex(el.style.borderColor || '#000000');
    }

    function bindLiveStyleEvents(el) {
      // Find all inputs and select them in styleEditorPanel
      const panel = document.getElementById('styleEditorPanel');
      if (!panel) return;

      // For all input type number
      panel.querySelectorAll('input[type="number"]').forEach(input => {
        const styleName = input.id.replace('Style', '').replace(/([A-Z])/g, '-$1').toLowerCase();

        input.addEventListener('input', (e) => {
          const unitSelect = document.getElementById(input.id + 'Set');
          const unit = unitSelect ? unitSelect.value : 'px';
          const value = e.target.value ? `${e.target.value}${unit}` : 'auto';

          el.style.setProperty(styleName, value, 'important');
        });
      });

      // For all input type color
      panel.querySelectorAll('input[type="color"]').forEach(input => {
        let styleName = input.id.replace(/([A-Z])/g, '-$1').toLowerCase();
        if (input.id === 'colorPicker') styleName = 'color'; // Fix for text color

        let clearBtn = input.parentNode.querySelector(".clear-color-btn");
        if (!clearBtn) {
          // Create clear button
          clearBtn = document.createElement('button');
          clearBtn.innerHTML = '<i class="bx bx-refresh-cw-alt-dot fs-6"></i>';
          clearBtn.className = 'btn btn-sm btn-label-secondary clear-color-btn';
          clearBtn.style.display = 'none';

          // Insert clear button after the color input
          input.parentNode.appendChild(clearBtn);
          input.addEventListener('input', (e) => {
            const value = e.target.value;
            if (value) {
              el.style.setProperty(styleName, value, 'important');
              clearBtn.style.removeProperty('display');
            } else {
              clearBtn.style.display = 'none';
            }
          });

          // Event: clear color when button clicked
          clearBtn.addEventListener("click", () => {
            input.value = '';
            el.style.removeProperty(styleName);
            clearBtn.style.display = 'none';
          });
        }
      });

      // For all select dropdowns (e.g. borderStyle, fontWeight, etc.)
      panel.querySelectorAll('select').forEach(select => {
        if (select.id.endsWith('Set')) return;

        const styleName = select.id.replace(/([A-Z])/g, '-$1').toLowerCase();
        select.addEventListener('change', (e) => {
          let value = e.target.value;
          if (styleName === 'font-family' && /\s/.test(value)) value = `"${value}"`;
          el.style.setProperty(styleName, value, 'important');
        });
      });

      // --- Text Align buttons (toggle) ---
      ['left', 'center', 'right', 'justify'].forEach(align => {
        const btn = panel.querySelector(`#align-${align}`);
        if (btn) {
          btn.addEventListener("click", () => {
            const currentAlign = el.style.getPropertyValue('text-align');
            // Toggle logic
            if (currentAlign === align) {
              el.style.removeProperty('text-align');
              btn.classList.remove('active');
            } else {
              el.style.setProperty('text-align', align, 'important');
              // Remove active from all buttons
              panel.querySelectorAll('#align-left, #align-center, #align-right, #align-justify').forEach(b => b.classList.remove('active'));
              btn.classList.add('active');
            }
          });
        }
      });

      // --- Font Style buttons (toggle) ---
      const fontStyles = [
        { id: 'style-bold', prop: 'font-weight', value: 'bold' },
        { id: 'style-italic', prop: 'font-style', value: 'italic' },
        { id: 'style-underline', prop: 'text-decoration', value: 'underline' },
        { id: 'style-strikethrough', prop: 'text-decoration', value: 'line-through' }
      ];

      fontStyles.forEach(style => {
        const btn = panel.querySelector(`#${style.id}`);
        if (btn) {
          btn.addEventListener("click", () => {
            const currentValue = el.style.getPropertyValue(style.prop);
            if (currentValue === style.value) {
              el.style.removeProperty(style.prop); // Remove style if clicked again
              btn.classList.remove('active');
            } else {
              el.style.setProperty(style.prop, style.value, 'important'); // Set style
              btn.classList.add('active');
            }
          });
        }
      });
    }

    function rgbToHex(rgb) {
      const result = rgb.match(/\d+/g);
      return result ? "#" + result.map(x => (+x).toString(16).padStart(2, "0")).join("") : "#ffffff";
    }

    function styleManagerMakeDraggable(panel, handleSelector) {
      const handle = panel.querySelector(handleSelector);
      if (!handle) return;

      let isDragging = false;
      let offsetX = 0, offsetY = 0;

      handle.style.cursor = "move";
      handle.addEventListener("mousedown", (e) => {
        isDragging = true;
        offsetX = e.clientX - panel.getBoundingClientRect().left;
        offsetY = e.clientY - panel.getBoundingClientRect().top;

        // Add dragging class (optional)
        panel.classList.add("dragging");
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
        e.preventDefault();
      });

      function onMouseMove(e) {
        if (!isDragging) return;

        const newX = e.clientX - offsetX;
        const newY = e.clientY - offsetY;

        panel.style.left = `${newX}px`;
        panel.style.top = `${newY}px`;
        panel.style.right = "auto"; // Prevent right positioning from overriding
        panel.style.bottom = "auto";
        panel.style.position = "fixed";
      }

      function onMouseUp() {
        isDragging = false;
        panel.classList.remove("dragging");
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      }
    }

    function closeStyleManager() {
      const panel = container.querySelector(".eva-style-panel");
      if (panel) {
        panel.remove();
        const styleBtn = container.querySelector('[eva-builder="style"]');
        if (styleBtn) styleBtn.classList.remove("active");
      }
    }

    function toggleShowBorder() {
      if (!iframeDoc) return;

      let style = iframeDoc.getElementById("eva-show-border-style");
      if (style) {
        style.remove();
      } else {
        style = iframeDoc.createElement("style");
        style.id = "eva-show-border-style";
        style.textContent = `
          div, section, article, ul, ol, li, header, footer, nav, aside, main, form, table, tr, td, th {
            outline: 1.5px dashed #f39c12 !important;
            outline-offset: -2px !important;
          }
        `;
        iframeDoc.head.appendChild(style);
      }
    }

    // --- Code Editor ---
    function showCodeEditorModal() {
      // Remove existing modal if any
      let existingModal = document.querySelector("#codeEditorModal");
      if (existingModal) existingModal.remove();

      // Create modal
      const modal = document.createElement("div");
      modal.id = "codeEditorModal";
      modal.className = "modal evaModal fade show d-block";
      modal.style.backgroundColor = "rgba(0,0,0,0.5)";
      modal.style.zIndex = "1305";
      modal.innerHTML = `
        <div class="modal-dialog modal-xl modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header py-4">
              <h6 class="modal-title">Code Editor</h6>
              <button type="button" class="btn-close" aria-label="Close"></button>
            </div>
            <div class="modal-body p-0" style="height: 70vh;">
              <textarea id="codeEditorArea"></textarea>
            </div>
            <div class="modal-footer py-4">
              <button type="button" class="btn btn-sm btn-secondary" id="cancelCodeEditor">Cancel</button>
              <button type="button" class="btn btn-sm btn-primary" id="saveCodeEditor">Submit</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      // Initialize CodeMirror
      const editorArea = modal.querySelector("#codeEditorArea");
      const editor = CodeMirror.fromTextArea(editorArea, {
        mode: "text/html",
        lineNumbers: true,
        theme: "material-darker",
        tabSize: 2,
        indentWithTabs: false,
        lineWrapping: false,
        autoCloseTags: true,
        matchBrackets: true
      });

      // Clone iframeDoc to mark readonly elements
      const cloneDoc = iframeDoc.cloneNode(true);

      // Remove <script> from jsOnBody before show the code editor
      const jsOnBodyList = options?.frameConfig?.jsOnBody || [];
      const jsOnBodySrcs = jsOnBodyList.filter(src => typeof src === "string");
      cloneDoc.querySelectorAll("script").forEach(script => {
        if (script.src && jsOnBodySrcs.includes(script.src)) {
          script.remove();
        }
      });      

      // Apply readOnly markers if any
      if (options.codeEditor.readOnly) {
        options.codeEditor.readOnly.forEach(selector => {
          cloneDoc.querySelectorAll(selector).forEach(el => {
            el.setAttribute("data-eva-readonly", "true");
          });
        });
      }

      const htmlContent = cloneDoc.body.innerHTML.trim();
      const formatted = typeof html_beautify === "function"
        ? html_beautify(htmlContent, { indent_size: 2 })
        : htmlContent;

      editor.setValue(formatted);
      editor.setSize("100%", "70vh");

      // Highlight readonly blocks visually & block edits
      setTimeout(() => {
        const allContent = editor.getValue();
        const parser = new DOMParser();
        const doc = parser.parseFromString(allContent, "text/html");

        doc.querySelectorAll("[data-eva-readonly]").forEach(el => {
          const html = el.outerHTML.trim();
          const startIndex = allContent.indexOf(html);
          if (startIndex === -1) return;

          const start = editor.posFromIndex(startIndex);
          const end = editor.posFromIndex(startIndex + html.length);

          editor.markText(start, end, {
            readOnly: true,
            inclusiveLeft: true,
            inclusiveRight: true,
            className: "cm-eva-readonly"
          });
        });
      }, 100);

      // Add dim style for readonly
      const styleTag = document.createElement("style");
      styleTag.innerHTML = `
        .cm-eva-readonly {
          background: rgba(0, 0, 0, 0.08);
          opacity: 0.6;
        }
      `;
      document.head.appendChild(styleTag);

      // Focus editor
      setTimeout(() => editor.refresh(), 10);

      // Close modal logic
      modal.querySelector(".btn-close").addEventListener("click", () => {
        modal.remove();
        customizerResetFromHide();
        overflowPageNormal();
      });

      modal.querySelector("#cancelCodeEditor").addEventListener("click", () => {
        modal.remove();
        customizerResetFromHide();
        overflowPageNormal();
      });

      const customizer = document.getElementById("template-customizer");
      if (customizer) {
        customizerToHide();
        overFlowPageHide();
      }

      // Save logic
      modal.querySelector("#saveCodeEditor").addEventListener("click", () => {
        let editedHtml = editor.getValue();

        // 1. Recover readonly block
        if (options.codeEditor.readOnly) {
          options.codeEditor.readOnly.forEach(selector => {
            const originalEl = iframeDoc.querySelector(selector);
            if (!originalEl) return;

            const temp = document.createElement("div");
            temp.innerHTML = editedHtml;

            const target = temp.querySelector(selector);
            if (target) {
              target.outerHTML = originalEl.outerHTML;
            }

            editedHtml = temp.innerHTML;
          });
        }

        // 2. Update only the editable part (if set), or the entire body.
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = editedHtml;

        if (options.codeEditor.editable?.length) {
          iframeDoc.querySelectorAll(options.codeEditor.editable.join(",")).forEach((el, index) => {
            const newEl = tempDiv.querySelectorAll(options.codeEditor.editable.join(","))[index];
            if (newEl) {
              el.replaceWith(newEl.cloneNode(true));
            }
          });
        } else {
          iframeDoc.body.innerHTML = editedHtml;
        }

        saveState();
        modal.remove();
        customizerResetFromHide();
        overflowPageNormal();
      });
    }

    // --- Undo/Redo ---
    function saveState() {
      if (!iframeDoc || !iframeDoc.body) return;
      undoStack.push(iframeDoc.body.innerHTML);
      if (undoStack.length > 100) undoStack.shift(); // Limit history
      redoStack = [];
    }

    function undo() {
      if (undoStack.length > 1) {
        const current = undoStack.pop();

        redoStack.push(current);
        iframeDoc.body.innerHTML = undoStack[undoStack.length - 1];
        cleanupGhostGlobal();
        closeStyleManager();
      }
    }

    function redo() {
      if (redoStack.length > 0) {
        const next = redoStack.pop();

        undoStack.push(next);
        iframeDoc.body.innerHTML = next;
        cleanupGhostGlobal();
        closeStyleManager();
      }
    }

    function cleanupGhostGlobal() {
      const ghost = iframeDoc.querySelector(".eva-ghost");
      if (ghost) ghost.remove();
    }

    // --- Fullscreen Toggle ---
    // --- Helper: save initial styles including computed styles ---
    const _savedStyles = new Map();

    function saveOriginalStyles(el, props) {
      if (!el) return;
      if (_savedStyles.has(el)) return; // Save only once

      const computed = getComputedStyle(el);
      const original = {};
      props.forEach((p) => {
        const inlineVal = el.style[p];
        if (inlineVal) {
          original[p] = inlineVal; // if there is an original inline style
        } else {
          original[p] = ""; // empty to return to auto
        }
      });
      _savedStyles.set(el, original);
    }

    function applyStyles(el, styles) {
      if (!el) return;
      const props = Object.keys(styles);
      saveOriginalStyles(el, props);
      props.forEach((prop) => {
        el.style[prop] = styles[prop];
      });
    }

    function restoreAllStyles() {
      for (const [el, styles] of _savedStyles.entries()) {
        Object.entries(styles).forEach(([prop, val]) => {
          el.style[prop] = val; // If val "", automatically returns to default
        });
      }
      _savedStyles.clear();
    }

    // --- Fullscreen Toggle Role ---
    //
    // Choose how the editor behaves in fullscreen mode (two options):
    // 1. "Above" code: fullscreen matches the editor's initial desktop size.
    // 2. "Below" code: true fullscreen, scaling to the user's entire screen.
    //

    // function setupFullscreenToggle() {
    //   const fullscreenBtn = container.querySelector('[eva-builder="fullscreen"]');
    //   if (!fullscreenBtn) return;

    //   fullscreenBtn.addEventListener("click", () => {
    //     const isFullscreen = document.fullscreenElement;

    //     if (!isFullscreen) {
    //       container.requestFullscreen?.(); // Enter fullscreen
    //       fullscreenBtn.classList.add("active");
    //     } else {
    //       document.exitFullscreen?.(); // Exit fullscreen
    //       fullscreenBtn.classList.remove("active");
    //     }
    //   });

    //   // When exit fullscreen with ESC, toggle button also turns off
    //   document.addEventListener("fullscreenchange", () => {
    //     if (!document.fullscreenElement) {
    //       fullscreenBtn.classList.remove("active");
    //     }
    //   });
    // }

    function setupFullscreenToggle() {
      const fullscreenBtn = container.querySelector('[eva-builder="fullscreen"]');
      const codeEditorBtn = container.querySelector('[eva-builder="code"]');
      const frameWrapper = container.querySelector(".eva-builder-frame");
      const iframe = frameWrapper?.querySelector("iframe");
      const menu = container.querySelector(".eva-builder-menu");
      const desktopSwitch = container.querySelector('[eva-builder-switch="desktop"]');

      if (!fullscreenBtn || !frameWrapper || !iframe || !menu) return;

      fullscreenBtn.addEventListener("click", () => {
        const isFullscreen = document.fullscreenElement;
        if (!isFullscreen) {
          container.requestFullscreen?.();
          fullscreenBtn.classList.add("active");
        } else {
          document.exitFullscreen?.();
          fullscreenBtn.classList.remove("active");
        }
      });

      const updateSizes = () => {
        const evaHeight = container.getBoundingClientRect().height;
        const menuHeight = menu.getBoundingClientRect().height;
        const contentHeight = evaHeight - menuHeight;

        applyStyles(frameWrapper, {
          width: "100%",
          height: `${contentHeight}px`,
        });

        applyStyles(iframe, {
          width: "100%",
          height: `${contentHeight}px`,
        });
      };

      desktopSwitch?.addEventListener("click", () => {
        const isActive = desktopSwitch.classList.contains("active");

        if (isActive) {
          updateSizes();
          window.addEventListener("resize", updateSizes);
        } else {
          restoreAllStyles();
          window.removeEventListener("resize", updateSizes);
        }
      });

      document.addEventListener("fullscreenchange", () => {
        const isFull = !!document.fullscreenElement;
        if (isFull) {
          fullscreenBtn.classList.add("active");
          codeEditorBtn.classList.add("disabled");
          updateSizes();
          window.addEventListener("resize", updateSizes);
        } else {
          fullscreenBtn.classList.remove("active");
          codeEditorBtn.classList.remove("disabled");
          window.removeEventListener("resize", updateSizes);
          restoreAllStyles(); // Back to original size
        }
      });

      document.addEventListener("fullscreenerror", () => {
        restoreAllStyles();
        fullscreenBtn.classList.remove("active");
      });
    }

    // Visibility actions buttons ---
    function toggleActionButtonsVisibility() {
      const saveBtn = container.querySelector('[eva-builder="save"]');
      const deleteBtn = container.querySelector('[eva-builder="delete"]');
      const clearBtn = container.querySelector('[eva-builder="clear"]');

      if (saveBtn && !options.actionBtn.save) saveBtn.remove();
      if (deleteBtn && !options.actionBtn.delete) deleteBtn.remove();
      if (clearBtn && !options.actionBtn.clear) clearBtn.remove();
    }

    // --- Action buttons ---
    function actionsBtn({ onSave, onDelete }) {
      const saveBtn = container.querySelector('[eva-builder="save"]');
      if (saveBtn) {
        saveBtn.addEventListener("click", () => {
          const fullClone = iframeDoc.body.cloneNode(true);

          // Helper for clear attributes
          function clean(el) {
            el.removeAttribute("data-editable");
            el.removeAttribute("draggable");
            el.removeAttribute("data-eva-highlight");
            el.classList.remove("eva-ghost");
          }

          fullClone.querySelectorAll("*").forEach(clean);

          function getKeyFromEl(el) {
            if (!el) return "unknown";

            let key = el.tagName.toLowerCase();

            if (el.id) {
              key += `#${el.id}`;
            } else if (el.className) {
              const className = el.className.trim().replace(/\s+/g, ".");
              if (className) key += `.${className}`;
            }

            return key;
          }

          const editableSelectors = options?.codeEditor?.editable || [];
          const editable = {};

          editableSelectors.forEach(selector => {
            fullClone.querySelectorAll(selector).forEach(el => {
              const key = getKeyFromEl(el);
              editable[key] = el.outerHTML.replace(/\s*\n\s*/g, "").trim();
            });
          });

          const readonlySelectors = options?.codeEditor?.readOnly || [];
          const readonly = {};

          readonlySelectors.forEach(selector => {
            fullClone.querySelectorAll(selector).forEach(el => {
              const key = getKeyFromEl(el);
              readonly[key] = el.outerHTML.replace(/\s*\n\s*/g, "").trim();
            });
          });

          const editorHtml = Array.from(fullClone.children)
            .map(el => el.outerHTML.replace(/\s*\n\s*/g, "").trim())
            .join("");

          if (typeof onSave === "function") {
            onSave({
              editor: editorHtml,
              editable,
              readonly
            });
          }
        });
      }

      const deleteBtn = container.querySelector('[eva-builder="delete"]');
      if (deleteBtn) {
        deleteBtn.addEventListener("click", onDelete);
      }

      const clearBtn = container.querySelector('[eva-builder="clear"]');
      if (clearBtn) {
        clearBtn.addEventListener("click", () => {
          iframeDoc.body.innerHTML = "";
          selectedElement = null;
          saveState();
        });
      }
    }

    // --- Add HTML into iframe at specific target/position ---
    function addInFrame(html, selector = "body", position = "replace") {
      withIframeDoc(doc => {
        const target = doc.querySelector(selector);
        if (!target) {
          console.warn(`Selector '${selector}' not found in iframe.`);
          return;
        }

        switch (position) {
          case "replace":
            target.innerHTML = html;
            break;
          case "append":
            target.insertAdjacentHTML("beforeend", html);
            break;
          case "prepend":
            target.insertAdjacentHTML("afterbegin", html);
            break;
        }

        if (Array.isArray(options.codeEditor.readOnly)) {
          options.codeEditor.readOnly.forEach(selector => {
            const readonlyEls = doc.querySelectorAll(selector);

            readonlyEls.forEach(el => {
              el.readonly = true; // ← Mark explicitly
            });
          });
        }
      });
    }

    // --- Add custom buttons ---
    function addButtons(...buttons) {
      const menu = container.querySelector(".eva-builder-menu");
      if (!menu) {
        console.warn("EvaEditor: Toolbar (.eva-builder-menu) tidak ditemukan.");
        return;
      }

      const actionGroup = menu.querySelector('[eva-builder="save"]')?.closest(".btn-group");
      let wrapper = null;

      // Create or retrieve custom groups
      let customGroup = menu.querySelector(".eva-builder-custom-group");
      if (!customGroup) {
        customGroup = document.createElement("div");
        customGroup.className = "btn-group eva-builder-custom-group";
        customGroup.setAttribute("role", "group");

        // If actionsBtn exists → insert before it, if not → insert at the right end
        if (actionGroup) {
          actionGroup.parentElement.insertBefore(customGroup, actionGroup);
        } else {
          menu.querySelector(".col.d-flex.justify-content-between:last-child")?.appendChild(customGroup);
        }
      }

      // Add buttons
      buttons.forEach(btnCfg => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.id = btnCfg.id || "";
        btn.className = btnCfg.class || "btn btn-sm btn-outline-dark";

        if (btnCfg.attributes) {
          btnCfg.attributes.split(" ").forEach(attrPair => {
            const [attr, val] = attrPair.split("=");
            if (attr) btn.setAttribute(attr, val ? val.replace(/['"]/g, "") : "");
          });
        }

        if (btnCfg.icon) {
          btn.innerHTML = `<i class="${btnCfg.icon}"></i>`;
        } else if (btnCfg.label) {
          btn.textContent = btnCfg.label;
        } else {
          btn.textContent = btnCfg.id || "Button";
        }

        if (typeof btnCfg.onClick === "function") {
          btn.addEventListener("click", btnCfg.onClick);
        }

        customGroup.appendChild(btn);
      });

      // Check if it needs to be wrapped in .d-flex justify-content-end gap-4
      if (actionGroup && customGroup && !menu.querySelector(".eva-actions-wrapper")) {
        // Create a wrapper
        wrapper = document.createElement("div");
        wrapper.className = "d-flex justify-content-end gap-4 eva-actions-wrapper";

        // Take the original parent
        const parent = actionGroup.parentElement;

        // Put customGroup and actionGroup into the wrapper
        parent.insertBefore(wrapper, actionGroup);
        wrapper.appendChild(customGroup);
        wrapper.appendChild(actionGroup);
      }
    }

    // --- Deferred execution if iframe not yet ready ---
    function flushQueue() {
      queue.forEach(cb => cb(iframeDoc));
      queue = [];
    }

    function withIframeDoc(cb) {
      if (iframeDoc) cb(iframeDoc);
      else queue.push(cb);
    }

    // --- Public API ---
    Object.assign(publicAPI, {
      injectMenuContent,
      getIframe: () => iframe,
      getIframeDoc: () => iframeDoc,
      addBlocks,
      addInFrame,
      withIframeDoc,
      actionsBtn,
      addButtons,
    });

    return publicAPI;
  }

  global.EvaPageEditor = {
    init: (options) => EvaPageBuilderInstance(options),
  };
})(typeof window !== "undefined" ? window : this);
