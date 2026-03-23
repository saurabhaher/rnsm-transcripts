(function() {
  "use strict";

  var scrollBtn = document.querySelector("[data-scroll-top='true']");
  if (!scrollBtn) {
    return;
  }

  scrollBtn.addEventListener("click", function() {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
})();
