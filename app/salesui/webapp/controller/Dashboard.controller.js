sap.ui.define([
  "sap/ui/core/mvc/Controller"
], function (Controller) {
  "use strict";

  return Controller.extend("sales.salesui.controller.Dashboard", {
    onInit: function () {
      console.log("Dashboard Loaded");
    }
  });
});