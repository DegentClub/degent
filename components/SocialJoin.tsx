'use client';

export default function SocialJoin() {
  return (
    <div 
      id="social_join"
      className="bg-image-card" style={{
          backgroundImage: 'url(https://degent.club/wp-content/uploads/2025/10/degens_grid-1030x579.jpg)'
        }}
    >

      {/* Content Wrapper */}
      <div className="bg-image-card-content">
        {/* Heading */}
        <h3>
          Join the Members group.{' '}
          {/* Gradient Text */}
          <strong className="gradient-text">
            Mint your legacy
          </strong>
        </h3>

        {/* Subheading */}
        <div className="subheading">
          <p>
            If everything&apos;s correctly set up, you&apos;ll automatically be allowed in. Just sit tight!
          </p>
        </div>

        {/* Divider/Spacer */}
        <div className="w-full max-w-[1200px] h-[30px] flex items-center" />

        {/* Button Row */}
        <div className="flex flex-wrap justify-center gap-2">
          {/* Telegram Button */}
          <a 
            href="https://t.me/+gr2mR-Wy1qBiNjk5" 
            target="_blank" 
            rel="noopener noreferrer nofollow" 
            className="btn btn-flex btn-blue btn-curtain"
          >
            
            {/* Button Content */}
             <span>Join Telegram Group</span>
            <i className="fa-brands fa-telegram"></i>
          </a>

          {/* X (Twitter) Button */}
          <a 
            href="https://x.com/degentclub" 
            target="_blank" 
            rel="noopener noreferrer nofollow" 
            className="btn btn-flex btn-dark btn-curtain"
          >
            {/* Button Content */}
            <span>Follow on X</span>
            <i className="fa-brands fa-x-twitter"></i>
          </a>
        </div>
      </div>
    </div>
  );
}

