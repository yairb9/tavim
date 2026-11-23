// Runs before the page is drawn: applies the saved appearance, and refuses to run inside another site's frame.
(function(){
  try{
    if(window.top !== window.self){ document.documentElement.style.display = "none"; return; }
    var t = localStorage.getItem("victory-theme");
    if(t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  }catch(e){}
})();
