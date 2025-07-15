window.startVideo = async function (videoId) {
    const video = document.getElementById(videoId);
    if (!video) {
        console.error("Video element not found:", videoId);
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = stream;
        video.play();
    } catch (err) {
        console.error("Error accessing webcam:", err);
    }
};