function isDeviceSupported() {
  return window.innerWidth >= 1024;
}

function showUnsupportedMessage() {
  const unsupportContent = `
    <div id="device-not-supported-message" class="d-flex justify-content-center align-items-center flex-column text-center p-5">
      <i class="bx bx-devices fs-1 text-muted mb-4"></i>
      <h4 class="fw-bold text-dark mb-2">Device Not Supported</h4>
      <p class="text-muted mb-3">
        Sorry, your current device is not optimized for using the Page Builder.<br>
        Please switch to a <strong class="text-dark">desktop or larger screen</strong> for the best experience.
      </p>
    </div>
  `;

  const containers = document.querySelectorAll(".eva-builder");

  if (!isDeviceSupported()) {
    if (containers.length > 0) {
      containers[0].insertAdjacentHTML('beforebegin', unsupportContent);
      containers.forEach(container => {
        container.style.display = "none";
      });
    }
  } else {
    containers.forEach(container => {
      container.style.display = "";
    });

    const unsupportedMessage = document.getElementById("device-not-supported-message");
    if (unsupportedMessage) {
      unsupportedMessage.remove();
    }
  }
}

showUnsupportedMessage();