// Enhancements and small behaviors for modern Reddit-like UI
console.log('assets/app.js loaded — UI enhancements active');

// Smooth scroll to comments when opening
const originalOpenComments = window.openComments || function(id){};
window.openComments = function(id){
    originalOpenComments(id);
    setTimeout(()=>{
        const modal = document.getElementById('modal-comments');
        if(modal) modal.querySelector('.modal').scrollIntoView({behavior:'smooth'});
    }, 120);
}

// Keyboard shortcut: 'n' to open new post modal
window.addEventListener('keydown', (e)=>{
    if(e.key === 'n' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA'){
        const modal = document.getElementById('modal-post');
        if(modal) modal.style.display = 'flex';
    }
});

// Tiny UX: close modal on overlay click
document.querySelectorAll('.modal-overlay').forEach(o=>{
    o.addEventListener('click', (ev)=>{
        if(ev.target === o) o.style.display='none';
    });
});

// Improve initial rendering: add subtle animation
setTimeout(()=>{
    document.querySelectorAll('.post-card').forEach((c,i)=>{
        c.style.opacity = 0; c.style.transform = 'translateY(6px)';
        setTimeout(()=>{ c.style.transition='all .28s cubic-bezier(.2,.9,.2,1)'; c.style.opacity=1; c.style.transform='none'; }, i*60);
    });
}, 120);

// --- File uploads (post media and profile avatar) ---
function fileToDataUrl(file, cb){
    const reader = new FileReader();
    reader.onload = () => cb(reader.result);
    reader.readAsDataURL(file);
}

document.addEventListener('DOMContentLoaded', ()=>{
    const postFile = document.getElementById('post-file');
    if(postFile){
        postFile.addEventListener('change', (ev)=>{
            const f = ev.target.files && ev.target.files[0];
            if(!f) return;
            const t = f.type || '';
            fileToDataUrl(f, (data)=>{
                const type = t.startsWith('video') ? t : 'image';
                document.getElementById('post-media-type').value = type;
                document.getElementById('post-media-src').value = data;
                const preview = document.getElementById('post-media-preview');
                preview.innerHTML = '';
                if(type === 'image'){
                    const img = document.createElement('img'); img.src = data; img.className = 'post-image'; preview.appendChild(img);
                } else {
                    const vid = document.createElement('video'); vid.src = data; vid.controls = true; vid.className = 'post-image'; preview.appendChild(vid);
                }
            });
        });
    }

    const commentFile = document.getElementById('comment-file');
    if(commentFile){
        commentFile.addEventListener('change', (ev)=>{
            const f = ev.target.files && ev.target.files[0];
            if(!f) return;
            const t = f.type || '';
            fileToDataUrl(f, (data)=>{
                const type = t.startsWith('video') ? t : 'image';
                document.getElementById('comment-media-type').value = type;
                document.getElementById('comment-media-src').value = data;
                const preview = document.getElementById('comment-media-preview');
                preview.innerHTML = '';
                if(type === 'image'){
                    const img = document.createElement('img'); img.src = data; img.className = 'post-image'; preview.appendChild(img);
                } else {
                    const vid = document.createElement('video'); vid.src = data; vid.controls = true; vid.className = 'post-image'; preview.appendChild(vid);
                }
            });
        });
    }

    const avatarInput = document.getElementById('profile-avatar-input');
    if(avatarInput){
        avatarInput.addEventListener('change', (ev)=>{
            const f = ev.target.files && ev.target.files[0];
            if(!f) return;
            fileToDataUrl(f, (data)=>{
                // save to state global
                if(window.state && window.state.user){
                    window.state.user.avatar = data;
                    window.saveState && window.saveState();
                    window.renderProfile && window.renderProfile();
                    const imgEl = document.getElementById('profile-avatar-img');
                    imgEl.src = data; imgEl.style.display = 'block';
                }
            });
        });
    }
});
